import {
  type CustomModelSetting,
  type ModelCapabilities,
  type MuseSettings,
  ProviderDriverKind,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { findSessionConfigOption } from "../acp/AcpRuntimeModel.ts";
import {
  MUSE_DEFAULT_MODEL_SLUG,
  MUSE_REASONING_EFFORT_CONFIG_ID,
  normalizeMuseReasoningEffort,
} from "../acp/MuseAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  supportsConversationRollback: false,
  badgeLabel: "Experimental",
  // Plan mode degrades to Muse `ask`: every action needs approval while the
  // agent can still describe its plan, which is the closest available shape.
  showInteractionModeToggle: true,
} as const;

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const HEALTH_CHECK_TIMEOUT = "30 seconds";
const SETUP_MESSAGE =
  "Muse Code is installed but is not signed in. Run `muse login` in a terminal.";
const AUTH_UNCHECKED_MESSAGE = "Muse Code is installed. Sign-in is not checked yet.";

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete/i.test(error.detail)
  );
}

/**
 * Muse Code signs in host-side (`muse login`); the bridge advertises no ACP
 * auth methods, so a completed session probe is the only "credentials work"
 * signal `initialize` can never provide.
 */
const MUSE_HOST_AUTH: ServerProviderAuth = {
  status: "authenticated",
  type: "host",
  label: "muse login",
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

type MuseSessionSetup =
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/** Flattens flat and grouped select options into (value, label) pairs. */
function selectOptionEntries(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<{ value: string; label: string; description?: string | undefined }> {
  return option.options.flatMap((entry) => {
    if ("value" in entry) {
      const label = nonEmptyString(entry.name) ?? entry.value;
      const description = nonEmptyString(entry.description);
      return [
        {
          value: entry.value,
          label,
          ...(description ? { description } : {}),
        },
      ];
    }
    return entry.options.flatMap((inner) => {
      const label = nonEmptyString(inner.name) ?? inner.value;
      const description = nonEmptyString(inner.description);
      return [
        {
          value: inner.value,
          label,
          ...(description ? { description } : {}),
        },
      ];
    });
  });
}

/**
 * The `reasoning_effort` session config option is the single reasoning ladder
 * shared by every Muse model, so the same descriptor attaches to each model.
 */
export function buildMuseModelCapabilities(
  reasoningOption: EffectAcpSchema.SessionConfigOption | undefined,
): ModelCapabilities {
  if (reasoningOption === undefined || reasoningOption.type !== "select") {
    return EMPTY_MODEL_CAPABILITIES;
  }
  const currentValue = normalizeMuseReasoningEffort(reasoningOption.currentValue);
  const seen = new Set<string>();
  const options = selectOptionEntries(reasoningOption).flatMap((entry) => {
    const value = normalizeMuseReasoningEffort(entry.value);
    if (value === undefined || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return [
      {
        value,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        isDefault: value === currentValue,
      },
    ];
  });
  if (options.length === 0) {
    return EMPTY_MODEL_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options,
      }),
    ],
  });
}

/**
 * Muse advertises its model list through the `model` session config option
 * rather than `session/new.models`; groups become `subProvider` labels.
 */
export function buildMuseModelsFromSession(
  sessionSetupResult: MuseSessionSetup | null | undefined,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const configOptions = sessionSetupResult?.configOptions;
  const modelOption = (configOptions ?? []).find(
    (option) => option.category === "model" && option.type === "select",
  );
  const reasoningOption = findSessionConfigOption(configOptions, MUSE_REASONING_EFFORT_CONFIG_ID);
  const capabilities = buildMuseModelCapabilities(reasoningOption);
  const currentModelId = modelOption?.type === "select" ? modelOption.currentValue.trim() : "";
  const seen = new Set<string>();
  const native = (modelOption?.type === "select" ? modelOption.options : []).flatMap(
    (entry): ServerProviderModel[] => {
      const options = "value" in entry ? [entry] : entry.options;
      const subProvider = "value" in entry ? undefined : nonEmptyString(entry.name);
      return options.flatMap((option): ServerProviderModel[] => {
        const slug = option.value.trim();
        if (!slug || seen.has(slug)) return [];
        seen.add(slug);
        return [
          {
            slug,
            name: nonEmptyString(option.name) ?? slug,
            ...(subProvider ? { subProvider } : {}),
            isCustom: false,
            ...(slug === currentModelId ? { isDefault: true } : {}),
            capabilities,
          },
        ];
      });
    },
  );
  return providerModelsFromSettings(
    [
      {
        slug: MUSE_DEFAULT_MODEL_SLUG,
        name: "Muse configured model",
        isCustom: false,
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
      ...native,
    ],
    customModels ?? [],
    EMPTY_MODEL_CAPABILITIES,
  );
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description?.trim();
    const hint = command.input?.hint?.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

interface MuseProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

export interface MuseProbeResult {
  readonly initialize: EffectAcpSchema.InitializeResponse;
  /**
   * Outcome of the throwaway session the probe only opens when
   * `includeSessionMetadata` is set. `authRequired` means the host reported
   * missing credentials (`muse login`); `failed` covers every other session
   * error and must not downgrade an otherwise healthy probe.
   */
  readonly session?:
    | {
        readonly setup: MuseSessionSetup;
        readonly commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined;
      }
    | { readonly authRequired: true }
    | { readonly failed: true }
    | undefined;
}

interface MuseProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  /**
   * Spawns a disposable `muse-acp-bridge`. `initialize` proves the binary is
   * present; the optional session probe is also the only credentials check,
   * because authentication is host-side and `authMethods` is always empty.
   */
  readonly probe: (
    includeSessionMetadata: boolean,
  ) => Effect.Effect<MuseProbeResult, EffectAcpErrors.AcpError | ProviderSetupError>;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}

/** Health uses initialize plus a session probe, which doubles as the login check. */
export const makeMuseProvider = Effect.fn("makeMuseProvider")(function* (
  settings: MuseSettings,
  options: MuseProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: buildMuseModelsFromSession(undefined, settings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Muse Code availability."
          : "Muse Code is disabled in T3 Code settings.",
      },
    }),
    // `muse login` is an interactive terminal flow and the bridge cannot be
    // installed from T3, so Settings only reports status and points at the CLIs.
    setup: { canAuthenticate: false, canInstall: false },
    supportsTextGeneration: false,
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<MuseProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkMuseProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    // The session probe carries models, slash commands, and the credentials
    // signal. It runs while any of those is missing; a healthy check stays
    // initialize-only so it never boots the agent or MCP discovery.
    const includeSessionMetadata =
      before.draft.auth.status !== "authenticated" ||
      !before.draft.models.some(
        (model) => !model.isCustom && model.slug !== MUSE_DEFAULT_MODEL_SLUG,
      ) ||
      before.draft.slashCommands.length === 0;
    const result = yield* options
      .probe(includeSessionMetadata)
      .pipe(Effect.timeoutOption(HEALTH_CHECK_TIMEOUT), Effect.result);
    const probed =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const initialized = probed?.initialize;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const session = probed?.session;
    const sessionAuthRequired =
      session !== undefined && "authRequired" in session && session.authRequired;
    const sessionSetup = session !== undefined && "setup" in session ? session.setup : undefined;
    const sessionCommands =
      session !== undefined && "setup" in session ? session.commands : undefined;
    const sessionCheckFailed =
      initialized !== undefined &&
      includeSessionMetadata &&
      session !== undefined &&
      "failed" in session;
    const auth =
      initialized === undefined
        ? undefined
        : sessionAuthRequired
          ? ({ status: "unauthenticated" } satisfies ServerProviderAuth)
          : sessionSetup !== undefined
            ? MUSE_HOST_AUTH
            : undefined;
    const effectiveAuth = auth ?? before.draft.auth;
    const errorMessage =
      initialized !== undefined
        ? sessionAuthRequired
          ? SETUP_MESSAGE
          : sessionCheckFailed
            ? "Muse Code is installed, but a session check failed."
            : effectiveAuth.status === "unknown"
              ? AUTH_UNCHECKED_MESSAGE
              : undefined
        : missingInstallation
          ? "Muse Code is not installed or `muse-acp-bridge` could not be found."
          : failure
            ? "Muse Code could not complete its local health check."
            : `Muse Code did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined && effectiveAuth.status === "authenticated"
        ? yield* options.supportsTextGeneration
        : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      return {
        ...state,
        draft: {
          ...draft,
          installed: missingInstallation
            ? false
            : initialized !== undefined
              ? true
              : draft.installed,
          version: initialized?.agentInfo?.version || draft.version,
          status: missingInstallation
            ? "error"
            : effectiveAuth.status === "unauthenticated"
              ? "warning"
              : initialized === undefined
                ? "error"
                : sessionCheckFailed || effectiveAuth.status === "unknown"
                  ? "warning"
                  : "ready",
          checkedAt: updatedAt,
          auth: effectiveAuth,
          supportsTextGeneration,
          ...(missingInstallation ? { models: [], slashCommands: [] } : {}),
          ...(sessionSetup !== undefined
            ? { models: buildMuseModelsFromSession(sessionSetup, settings.customModels) }
            : {}),
          ...(sessionCommands !== undefined
            ? { slashCommands: nativeCommands(sessionCommands) }
            : {}),
          ...(errorMessage ? { message: errorMessage } : {}),
        },
      } satisfies MuseProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("muse"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((state) =>
          options.stampIdentity(state.draft).pipe(Effect.flatMap(publishSnapshot)),
        ),
      ),
  });

  const onSessionStarted = Effect.fn("MuseProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
  ) {
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      const { message: _previousMessage, ...draft } = state.draft;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: settings.enabled ? "ready" : "disabled",
          version: started.initializeResult.agentInfo?.version || draft.version,
          // A session exists, so host credentials worked at least once.
          auth: MUSE_HOST_AUTH,
          checkedAt: updatedAt,
          models: buildMuseModelsFromSession(started.sessionSetupResult, settings.customModels),
          supportsTextGeneration,
        },
      } satisfies MuseProviderState;
    });
  });

  const onAvailableCommands = Effect.fn("MuseProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) {
    const slashCommands = nativeCommands(commands);
    yield* SubscriptionRef.update(metadata, (state) =>
      state.draft.auth.status === "unauthenticated"
        ? state
        : { ...state, draft: { ...state.draft, slashCommands } },
    );
  });

  const onAuthRequired = Effect.fn("MuseProvider.onAuthRequired")(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          draft: {
            ...state.draft,
            auth: { status: "unauthenticated" },
            status: settings.enabled ? "warning" : "disabled",
            message: SETUP_MESSAGE,
            checkedAt: updatedAt,
            models: buildMuseModelsFromSession(undefined, settings.customModels),
            slashCommands: [],
            supportsTextGeneration: false,
          },
        }) satisfies MuseProviderState,
    );
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onAvailableCommands,
    onAuthRequired: onAuthRequired(),
  };
});

import {
  type CustomModelSetting,
  type HermesSettings,
  type ModelCapabilities,
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
import {
  HERMES_DEFAULT_MODEL_SLUG,
  isValidHermesReasoningEffortToken,
  resolveHermesAuthMethodId,
} from "../acp/HermesAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  supportsConversationRollback: false,
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
} as const;

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const HEALTH_CHECK_TIMEOUT = "30 seconds";
const SETUP_MESSAGE =
  "Hermes is installed but has no configured model provider. Run `hermes setup` in a terminal.";
const AUTH_UNCHECKED_MESSAGE = "Hermes is installed. Provider configuration is not checked yet.";

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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hermesReasoningOptionsFromModel(model: EffectAcpSchema.ModelInfo): {
  readonly options: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    isDefault?: boolean;
  }>;
  readonly currentValue: string | undefined;
} {
  const meta = model._meta;
  if (!meta || meta.supportsReasoningEffort === false) {
    return { options: [], currentValue: undefined };
  }

  const currentEffort = nonEmptyString(meta.reasoningEffort);
  const advertisedOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  const seen = new Set<string>();
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    advertisedDefault: boolean;
  }> = [];

  for (const entry of advertisedOptions) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawValue = nonEmptyString(entry.value);
    const rawId = nonEmptyString(entry.id);
    const value =
      rawValue && isValidHermesReasoningEffortToken(rawValue)
        ? rawValue
        : rawId && isValidHermesReasoningEffortToken(rawId)
          ? rawId
          : undefined;
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const description = nonEmptyString(entry.description);
    options.push({
      value,
      label: nonEmptyString(entry.label) ?? value,
      ...(description ? { description } : {}),
      advertisedDefault: entry.default === true || entry.isDefault === true,
    });
  }

  const currentValue =
    currentEffort && options.some((option) => option.value === currentEffort)
      ? currentEffort
      : undefined;
  const advertisedDefaults = options.filter((option) => option.advertisedDefault);
  const selectedDefault =
    advertisedDefaults.find((option) => option.value === currentValue)?.value ??
    advertisedDefaults[0]?.value;
  return {
    options: options.map(({ value, label, description }) => ({
      value,
      label,
      ...(description ? { description } : {}),
      ...(value === selectedDefault ? { isDefault: true } : {}),
    })),
    currentValue: currentValue ?? selectedDefault,
  };
}

export function buildHermesModelCapabilities(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const reasoning = hermesReasoningOptionsFromModel(model);
  return reasoning.options.length > 0
    ? createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: reasoning.options.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.isDefault ? { isDefault: true } : {}),
            })),
            ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
          },
        ],
      })
    : EMPTY_MODEL_CAPABILITIES;
}

/**
 * Hermes model ids are provider-qualified (`openrouter:x`, `xai-oauth:y`); the
 * prefix doubles as the picker's sub-provider group. `description` repeats the
 * provider name, so it is not surfaced separately.
 */
export function buildHermesModelsFromSession(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const currentModelId = modelState?.currentModelId?.trim() ?? "";
  const seen = new Set<string>();
  const native = (modelState?.availableModels ?? []).flatMap((model): ServerProviderModel[] => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    // `custom:<provider>:<model>` ids group under the real provider name.
    const segments = slug.split(":");
    const subProvider =
      segments.length > 2 && segments[0] === "custom"
        ? segments[1]
        : segments.length > 1
          ? segments[0]
          : undefined;
    return [
      {
        slug,
        name: model.name.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: buildHermesModelCapabilities(model),
      },
    ];
  });
  return providerModelsFromSettings(
    [
      {
        slug: HERMES_DEFAULT_MODEL_SLUG,
        name: "Hermes configured model",
        isCustom: false,
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
      ...native,
    ],
    customModels ?? [],
    EMPTY_MODEL_CAPABILITIES,
  );
}

function hermesAuthFromInitialize(
  initialize: EffectAcpSchema.InitializeResponse,
): ServerProviderAuth {
  const methodId = resolveHermesAuthMethodId(initialize);
  // Hermes only advertises an agent-managed method when credentials resolve.
  return methodId !== undefined
    ? { status: "authenticated", type: methodId, label: `${methodId} runtime credentials` }
    : { status: "unauthenticated" };
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

interface HermesProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

export interface HermesProbeResult {
  readonly initialize: EffectAcpSchema.InitializeResponse;
  readonly models: EffectAcpSchema.SessionModelState | null | undefined;
  readonly commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined;
}

interface HermesProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  /**
   * Spawns a disposable `hermes acp`. `initialize` is the health/auth signal;
   * `models`/`commands` come from a throwaway session the probe only opens
   * when `includeSessionMetadata` is set — `session/new` boots the agent and
   * MCP discovery, so steady-state checks stay initialize-only.
   */
  readonly probe: (
    includeSessionMetadata: boolean,
  ) => Effect.Effect<HermesProbeResult, EffectAcpErrors.AcpError | ProviderSetupError>;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}

/** Health uses initialize only. Session callbacks supply account-specific metadata. */
export const makeHermesProvider = Effect.fn("makeHermesProvider")(function* (
  settings: HermesSettings,
  options: HermesProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: buildHermesModelsFromSession(undefined, settings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Hermes availability."
          : "Hermes is disabled in T3 Code settings.",
      },
    }),
    // T3 cannot drive `hermes setup` (interactive terminal) or install the
    // binary, so Settings only reports status and points at the CLI.
    setup: { canAuthenticate: false, canInstall: false },
    supportsTextGeneration: false,
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<HermesProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkHermesProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    // Session-advertised models and slash commands are otherwise invisible
    // until the first turn starts a session, so a cold list upgrades this
    // check to a session probe. Once populated, `onSessionStarted` and
    // `onAvailableCommands` keep them fresh.
    const includeSessionMetadata =
      !before.draft.models.some(
        (model) => !model.isCustom && model.slug !== HERMES_DEFAULT_MODEL_SLUG,
      ) || before.draft.slashCommands.length === 0;
    const result = yield* options
      .probe(includeSessionMetadata)
      .pipe(Effect.timeoutOption(HEALTH_CHECK_TIMEOUT), Effect.result);
    const probed =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const initialized = probed?.initialize;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const auth = initialized !== undefined ? hermesAuthFromInitialize(initialized) : undefined;
    const errorMessage =
      initialized !== undefined
        ? auth?.status === "unauthenticated"
          ? SETUP_MESSAGE
          : undefined
        : missingInstallation
          ? "Hermes Agent is not installed or its executable could not be found."
          : failure
            ? "Hermes could not complete its local health check."
            : `Hermes did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined && auth?.status === "authenticated"
        ? yield* options.supportsTextGeneration
        : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const message =
        errorMessage ??
        (state.draft.auth.status === "authenticated" ? undefined : AUTH_UNCHECKED_MESSAGE);
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
            : auth?.status === "unauthenticated"
              ? "warning"
              : errorMessage
                ? "error"
                : auth?.status === "authenticated"
                  ? "ready"
                  : "warning",
          checkedAt: updatedAt,
          ...(auth !== undefined ? { auth } : {}),
          supportsTextGeneration,
          ...(missingInstallation ? { models: [], slashCommands: [] } : {}),
          ...(probed?.models != null
            ? { models: buildHermesModelsFromSession(probed.models, settings.customModels) }
            : {}),
          ...(probed?.commands !== undefined
            ? { slashCommands: nativeCommands(probed.commands) }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies HermesProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("hermes"),
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

  const onSessionStarted = Effect.fn("HermesProvider.onSessionStarted")(function* (
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
          auth: hermesAuthFromInitialize(started.initializeResult),
          checkedAt: updatedAt,
          models: buildHermesModelsFromSession(
            started.sessionSetupResult.models,
            settings.customModels,
          ),
          supportsTextGeneration,
        },
      } satisfies HermesProviderState;
    });
  });

  const onAvailableCommands = Effect.fn("HermesProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) {
    const slashCommands = nativeCommands(commands);
    yield* SubscriptionRef.update(metadata, (state) =>
      state.draft.auth.status === "unauthenticated"
        ? state
        : { ...state, draft: { ...state.draft, slashCommands } },
    );
  });

  const onAuthRequired = Effect.fn("HermesProvider.onAuthRequired")(function* () {
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
            models: buildHermesModelsFromSession(undefined, settings.customModels),
            slashCommands: [],
            supportsTextGeneration: false,
          },
        }) satisfies HermesProviderState,
    );
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onAvailableCommands,
    onAuthRequired: onAuthRequired(),
  };
});

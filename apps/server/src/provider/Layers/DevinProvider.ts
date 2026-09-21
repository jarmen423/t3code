import {
  type CustomModelSetting,
  type DevinSettings,
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
  DEVIN_DEFAULT_MODEL_SLUG,
  devinModelConfigOption,
  devinModelOptions,
  type DevinAuthStatus,
} from "../acp/DevinAcpSupport.ts";
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

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  badgeLabel: "Experimental",
  showInteractionModeToggle: true,
} as const;

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const HEALTH_CHECK_TIMEOUT = "30 seconds";
const SETUP_MESSAGE =
  "Devin is installed but not signed in. Run `devin auth login` in a terminal on this machine, or `devin auth login --force-manual-token-flow` on a headless server.";
const AUTH_UNCHECKED_MESSAGE = "Devin is installed. Sign-in status could not be determined.";

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

function devinAuthFromStatus(authStatus: DevinAuthStatus): ServerProviderAuth {
  switch (authStatus) {
    case "authenticated":
      return { status: "authenticated", type: "devin-cli", label: "Devin CLI credentials" };
    case "unauthenticated":
      return { status: "unauthenticated" };
    case "unknown":
      return { status: "unknown" };
  }
}

/**
 * Picker group for a native Devin model id. Cognition's own families
 * (`swe-*`, `adaptive`, `inkling-*`) group under "Devin"; `fusion-*` ids embed
 * a member family's name (`fusion-claude-…`), so they must be classified
 * before the vendor prefixes. Legacy `MODEL_*` enum ids get their own group.
 */
export function devinSubProvider(modelId: string): string | undefined {
  const id = modelId.trim();
  if (id.startsWith("MODEL_")) {
    return "Legacy";
  }
  const prefix = id.split("-", 1)[0]?.toLowerCase();
  switch (prefix) {
    case "claude":
      return "Claude";
    case "gpt":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "glm":
      return "GLM";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "deepseek":
      return "DeepSeek";
    case "nemotron":
      return "NVIDIA";
    case "fusion":
    case "swe":
    case "inkling":
    case "adaptive":
      return "Devin";
    default:
      return undefined;
  }
}

/**
 * Devin advertises its model catalog on the `model` session config option's
 * select values — session setup carries no `models` field. The product
 * "default" slug always leads the picker; native ids follow in the order
 * Devin advertises them, with the current selection marked default.
 */
export function buildDevinModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelConfig = devinModelConfigOption(configOptions);
  const currentModelId =
    modelConfig?.type === "select" ? modelConfig.currentValue.trim() : undefined;
  const seen = new Set<string>();
  const native = devinModelOptions(modelConfig).flatMap((option): ServerProviderModel[] => {
    const slug = option.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const subProvider = devinSubProvider(slug);
    return [
      {
        slug,
        name: option.name.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
    ];
  });
  return providerModelsFromSettings(
    [
      {
        slug: DEVIN_DEFAULT_MODEL_SLUG,
        name: "Devin configured model",
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

interface DevinProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

export interface DevinProbeResult {
  readonly initialize: EffectAcpSchema.InitializeResponse;
  readonly authStatus: DevinAuthStatus;
  /** `devin --version` output when readable; `agentInfo.version` is the fallback. */
  readonly version: string | null;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined;
  readonly commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined;
}

interface DevinProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  /**
   * Spawns a disposable `devin acp` plus `devin auth status` and
   * `devin --version`. `initialize` is the health signal; `authStatus` is the
   * sign-in signal — ACP cannot reveal it. `configOptions`/`commands` come
   * from a throwaway session the probe only opens when
   * `includeSessionMetadata` is set — `session/new` boots the agent and MCP
   * discovery, so steady-state checks stay initialize-only.
   */
  readonly probe: (
    includeSessionMetadata: boolean,
  ) => Effect.Effect<DevinProbeResult, EffectAcpErrors.AcpError | ProviderSetupError>;
  /** Re-reads `devin auth status` after a session starts so sign-in shows promptly. */
  readonly probeAuthStatus: Effect.Effect<DevinAuthStatus>;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}

/** Health uses initialize + `devin auth status`. Session callbacks supply account metadata. */
export const makeDevinProvider = Effect.fn("makeDevinProvider")(function* (
  settings: DevinSettings,
  options: DevinProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: buildDevinModelsFromConfigOptions(undefined, settings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Devin availability."
          : "Devin is disabled in T3 Code settings.",
      },
    }),
    // T3 cannot drive `devin-browser` auth (browser on the server host) or
    // install the binary, so Settings only reports status and points at the
    // CLI.
    setup: { canAuthenticate: false, canInstall: false },
    supportsTextGeneration: false,
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<DevinProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkDevinProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    // Session-advertised models and slash commands are otherwise invisible
    // until the first turn starts a session, so a cold list upgrades this
    // check to a session probe. Once populated, `onSessionStarted` and
    // `onAvailableCommands` keep them fresh.
    const includeSessionMetadata =
      !before.draft.models.some(
        (model) => !model.isCustom && model.slug !== DEVIN_DEFAULT_MODEL_SLUG,
      ) || before.draft.slashCommands.length === 0;
    const result = yield* options
      .probe(includeSessionMetadata)
      .pipe(Effect.timeoutOption(HEALTH_CHECK_TIMEOUT), Effect.result);
    const probed =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const initialized = probed?.initialize;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const auth = probed !== undefined ? devinAuthFromStatus(probed.authStatus) : undefined;
    const errorMessage =
      initialized !== undefined
        ? probed?.authStatus === "unauthenticated"
          ? SETUP_MESSAGE
          : undefined
        : missingInstallation
          ? "Devin is not installed or its executable could not be found."
          : failure
            ? "Devin could not complete its local health check."
            : `Devin did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined && auth?.status === "authenticated"
        ? yield* options.supportsTextGeneration
        : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      // Decide from the auth this probe established, not the prior draft's:
      // the first successful check starts from an `unknown` draft, and the
      // "could not be determined" hint must not outlive its own answer.
      const message =
        errorMessage ?? (auth?.status === "authenticated" ? undefined : AUTH_UNCHECKED_MESSAGE);
      return {
        ...state,
        draft: {
          ...draft,
          installed: missingInstallation
            ? false
            : initialized !== undefined
              ? true
              : draft.installed,
          version: probed?.version ?? initialized?.agentInfo?.version ?? draft.version,
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
          ...(probed?.configOptions !== undefined
            ? {
                models: buildDevinModelsFromConfigOptions(
                  probed.configOptions,
                  settings.customModels,
                ),
              }
            : {}),
          ...(probed?.commands !== undefined
            ? { slashCommands: nativeCommands(probed.commands) }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies DevinProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("devin"),
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

  const onSessionStarted = Effect.fn("DevinProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
  ) {
    // A session starting does not prove credentials — session/new succeeds
    // while logged out — so auth is re-probed rather than assumed. A known
    // unauthenticated probe publishes the same setup-required warning as
    // `onAuthRequired`; a known authenticated probe publishes the normal ready
    // state with the probed text-generation capability. An unknown probe says
    // nothing new, so the whole last-known auth-dependent snapshot (auth,
    // status, message, text generation) carries over coherently instead of
    // being rebuilt around a preserved auth field alone.
    const freshAuthStatus = yield* options.probeAuthStatus;
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      // Capture before stripping: an unknown re-probe re-publishes exactly
      // this message, while a known one must not inherit it.
      const { message: previousMessage, ...draft } = state.draft;
      const preserve = freshAuthStatus === "unknown";
      const setupRequired = freshAuthStatus === "unauthenticated";
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: settings.enabled
            ? preserve
              ? draft.status
              : setupRequired
                ? "warning"
                : "ready"
            : "disabled",
          version: started.initializeResult.agentInfo?.version || draft.version,
          ...(preserve ? {} : { auth: devinAuthFromStatus(freshAuthStatus) }),
          checkedAt: updatedAt,
          models: buildDevinModelsFromConfigOptions(
            started.sessionSetupResult.configOptions,
            settings.customModels,
          ),
          ...(preserve
            ? {}
            : { supportsTextGeneration: setupRequired ? false : supportsTextGeneration }),
          ...(preserve
            ? previousMessage
              ? { message: previousMessage }
              : {}
            : setupRequired
              ? { message: SETUP_MESSAGE }
              : {}),
        },
      } satisfies DevinProviderState;
    });
  });

  const onAvailableCommands = Effect.fn("DevinProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) {
    const slashCommands = nativeCommands(commands);
    yield* SubscriptionRef.update(metadata, (state) =>
      state.draft.auth.status === "unauthenticated"
        ? state
        : { ...state, draft: { ...state.draft, slashCommands } },
    );
  });

  const onAuthRequired = Effect.fn("DevinProvider.onAuthRequired")(function* () {
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
            models: buildDevinModelsFromConfigOptions(undefined, settings.customModels),
            slashCommands: [],
            supportsTextGeneration: false,
          },
        }) satisfies DevinProviderState,
    );
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onAvailableCommands,
    onAuthRequired: onAuthRequired(),
  };
});

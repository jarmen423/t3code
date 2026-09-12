import {
  type HermesSettings,
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
import { HERMES_DEFAULT_MODEL_SLUG, resolveHermesAuthMethodId } from "../acp/HermesAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
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

/**
 * Hermes model ids are provider-qualified (`openrouter:x`, `xai-oauth:y`); the
 * prefix doubles as the picker's sub-provider group. `description` repeats the
 * provider name, so it is not surfaced separately.
 */
export function buildHermesModelsFromSession(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const currentModelId = modelState?.currentModelId?.trim() ?? "";
  const seen = new Set<string>();
  const native = (modelState?.availableModels ?? []).flatMap((model): ServerProviderModel[] => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const subProvider = slug.includes(":") ? slug.slice(0, slug.indexOf(":")) : undefined;
    return [
      {
        slug,
        name: model.name.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
    ];
  });
  return [
    {
      slug: HERMES_DEFAULT_MODEL_SLUG,
      name: "Hermes configured model",
      isCustom: false,
      capabilities: EMPTY_MODEL_CAPABILITIES,
    },
    ...native,
  ];
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

interface HermesProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  /** Spawns a disposable `hermes acp` and returns `initialize` only. */
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
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
      models: [
        {
          slug: HERMES_DEFAULT_MODEL_SLUG,
          name: "Hermes configured model",
          isCustom: false,
          capabilities: EMPTY_MODEL_CAPABILITIES,
        },
      ],
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
    // T3 cannot drive `hermes --setup` (interactive terminal) or install the
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
    const result = yield* options.probe.pipe(
      Effect.timeoutOption(HEALTH_CHECK_TIMEOUT),
      Effect.result,
    );
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
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
          installed: !missingInstallation,
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
          models: buildHermesModelsFromSession(started.sessionSetupResult.models),
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
            models: [
              {
                slug: HERMES_DEFAULT_MODEL_SLUG,
                name: "Hermes configured model",
                isCustom: false,
                capabilities: EMPTY_MODEL_CAPABILITIES,
              },
            ],
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

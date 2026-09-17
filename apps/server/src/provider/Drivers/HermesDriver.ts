import { HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import { makeHermesProvider, type HermesProbeResult } from "../Layers/HermesProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeHermesAcpRuntime, resolveHermesAuthMethodId } from "../acp/HermesAcpSupport.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER = ProviderDriverKind.make("hermes");
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export type HermesDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Hermes Agent speaks ACP over `hermes acp`. The process always runs on the
 * host that owns the T3 server — remote and mobile clients only ever see the
 * driver's snapshots and events.
 */
export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;

      // `initialize` is a single local round trip, so it stays the probe's
      // health signal — it never authenticates or opens a session, which could
      // start an interactive setup or boot MCP servers. When asked, the probe
      // additionally opens a throwaway session to harvest the advertised
      // models and slash commands for the pickers; its failure cannot
      // downgrade a healthy probe.
      const probe = (includeSessionMetadata: boolean) =>
        Effect.gen(function* () {
          const runtime = yield* makeHermesAcpRuntime({
            hermesSettings: effectiveConfig,
            environment: processEnv,
            childProcessSpawner: spawner,
            cwd: serverConfig.stateDir,
            clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
          }).pipe(Effect.provideService(Crypto.Crypto, crypto));
          const initialize = yield* runtime.initialize();
          const session =
            includeSessionMetadata && resolveHermesAuthMethodId(initialize) !== undefined
              ? yield* Effect.gen(function* () {
                  // Commands arrive as an `available_commands_update` session
                  // notification rather than on the `session/new` response, so
                  // the events stream is drained for it alongside the start.
                  const probeScope = yield* Effect.scope;
                  const commandsDeferred =
                    yield* Deferred.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>();
                  yield* Stream.runForEach(runtime.getEvents(), (event) =>
                    event._tag === "AvailableCommandsUpdated"
                      ? Deferred.succeed(commandsDeferred, event.availableCommands)
                      : Effect.void,
                  ).pipe(Effect.forkIn(probeScope));
                  const started = yield* runtime.start();
                  const commands = yield* Deferred.await(commandsDeferred).pipe(
                    Effect.timeoutOption("3 seconds"),
                    Effect.map(Option.getOrUndefined),
                  );
                  return { models: started.sessionSetupResult.models, commands };
                }).pipe(
                  Effect.match({
                    onFailure: () => undefined,
                    onSuccess: (value) => value,
                  }),
                )
              : undefined;
          return {
            initialize,
            models: session?.models,
            commands: session?.commands,
          } satisfies HermesProbeResult;
        }).pipe(Effect.scoped);

      const provider = yield* makeHermesProvider(effectiveConfig, {
        stampIdentity: (draft) => Effect.sync(() => stampIdentity(draft)),
        probe,
        // Text generation needs a working session, which needs provider
        // credentials — the probe already established that.
        supportsTextGeneration: Effect.succeed(true),
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build Hermes snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeHermesAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        onSessionStarted: provider.onSessionStarted,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeHermesTextGeneration(effectiveConfig, processEnv);

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

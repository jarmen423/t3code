import { MuseSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { makeMuseProvider, type MuseProbeResult } from "../Layers/MuseProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { isMuseAuthRequiredError, makeMuseAcpRuntime } from "../acp/MuseAcpSupport.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export type MuseDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Muse Code speaks ACP through `muse-acp-bridge`, a thin stdio wrapper around
 * the `muse` CLI. Authentication is host-side (`muse login`); the bridge
 * advertises no ACP auth methods, so the throwaway session the probe opens is
 * also the only credentials check. The process always runs on the host that
 * owns the T3 server — remote and mobile clients only ever see the driver's
 * snapshots and events.
 */
export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Muse Code",
    supportsMultipleInstances: true,
  },
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => decodeMuseSettings({}),
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
      const effectiveConfig = { ...config, enabled } satisfies MuseSettings;

      // `initialize` proves the binary is present; the session probe harvests
      // models, slash commands, and the login signal (`session/new` is where
      // the host reports authRequired). A non-auth session failure cannot
      // downgrade a healthy probe.
      const probe = (includeSessionMetadata: boolean) =>
        Effect.gen(function* () {
          const runtime = yield* makeMuseAcpRuntime({
            museSettings: effectiveConfig,
            environment: processEnv,
            childProcessSpawner: spawner,
            cwd: serverConfig.stateDir,
            clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
          }).pipe(Effect.provideService(Crypto.Crypto, crypto));
          const initialize = yield* runtime.initialize();
          const session = includeSessionMetadata
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
                return { setup: started.sessionSetupResult, commands } as const;
              }).pipe(
                Effect.match({
                  onFailure: (cause) =>
                    isMuseAuthRequiredError(cause)
                      ? ({ authRequired: true } as const)
                      : ({ failed: true } as const),
                  onSuccess: (value) => value,
                }),
              )
            : undefined;
          return {
            initialize,
            session,
          } satisfies MuseProbeResult;
        }).pipe(Effect.scoped);

      const provider = yield* makeMuseProvider(effectiveConfig, {
        stampIdentity: (draft) => Effect.sync(() => stampIdentity(draft)),
        probe,
        // Text generation needs a working session, which needs host
        // credentials — the probe's session already established that.
        supportsTextGeneration: Effect.succeed(true),
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build Muse snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeMuseAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        onSessionStarted: provider.onSessionStarted,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, processEnv);

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

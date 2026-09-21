import { DevinSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDevinTextGeneration } from "../../textGeneration/DevinTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { makeDevinProvider, type DevinProbeResult } from "../Layers/DevinProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeDevinAcpRuntime, probeDevinAuthStatus } from "../acp/DevinAcpSupport.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER = ProviderDriverKind.make("devin");
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export type DevinDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Devin speaks ACP over `devin acp`. The process always runs on the host that
 * owns the T3 server — remote and mobile clients only ever see the driver's
 * snapshots and events.
 */
export const DevinDriver: ProviderDriver<DevinSettings, DevinDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Devin",
    supportsMultipleInstances: true,
  },
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => decodeDevinSettings({}),
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
      const effectiveConfig = { ...config, enabled } satisfies DevinSettings;

      const probeAuthStatus = probeDevinAuthStatus(effectiveConfig, processEnv).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      // `devin --version` is the human-readable version; `agentInfo.version`
      // is a dev build stamp. Any failure leaves the probe's fallback.
      const probeVersion = Effect.gen(function* () {
        const command = effectiveConfig.binaryPath || "devin";
        const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
          env: processEnv,
        });
        const result = yield* spawnAndCollect(
          command,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: processEnv,
            shell: spawnCommand.shell,
          }),
        );
        const firstLine = result.stdout.trim().split("\n", 1)[0]?.trim();
        return firstLine || null;
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption("10 seconds"),
        Effect.orElseSucceed(() => Option.none()),
        Effect.map((option) => (Option.isSome(option) ? option.value : null)),
      );

      // `initialize` is a single local round trip, so it stays the probe's
      // health signal — it never authenticates or opens a session, which boots
      // the agent and MCP discovery. When asked, the probe additionally opens
      // a throwaway session to harvest the config-option models and slash
      // commands for the pickers; its failure cannot downgrade a healthy probe.
      const probe = (includeSessionMetadata: boolean) =>
        Effect.gen(function* () {
          const runtime = yield* makeDevinAcpRuntime({
            devinSettings: effectiveConfig,
            environment: processEnv,
            childProcessSpawner: spawner,
            cwd: serverConfig.stateDir,
            clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
          }).pipe(Effect.provideService(Crypto.Crypto, crypto));
          const initialize = yield* runtime.initialize();
          const authStatus = yield* probeAuthStatus;
          const version = yield* probeVersion;
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
                return {
                  configOptions: started.sessionSetupResult.configOptions,
                  commands,
                };
              }).pipe(
                Effect.match({
                  onFailure: () => undefined,
                  onSuccess: (value) => value,
                }),
              )
            : undefined;
          return {
            initialize,
            authStatus,
            version,
            configOptions: session?.configOptions ?? undefined,
            commands: session?.commands,
          } satisfies DevinProbeResult;
        }).pipe(Effect.scoped);

      const provider = yield* makeDevinProvider(effectiveConfig, {
        stampIdentity: (draft) => Effect.sync(() => stampIdentity(draft)),
        probe,
        probeAuthStatus,
        // Text generation needs a working session, which needs credentials —
        // the probe already established that.
        supportsTextGeneration: Effect.succeed(true),
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build Devin snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeDevinAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        onSessionStarted: provider.onSessionStarted,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeDevinTextGeneration(effectiveConfig, processEnv);

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

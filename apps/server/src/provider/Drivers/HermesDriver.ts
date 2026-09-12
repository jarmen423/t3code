import { HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import { makeHermesProvider } from "../Layers/HermesProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";
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

      // `initialize` is a single local round trip, so the probe never
      // authenticates or opens a session — those could start an interactive
      // setup or boot MCP servers.
      const probe = Effect.gen(function* () {
        const runtime = yield* makeHermesAcpRuntime({
          hermesSettings: effectiveConfig,
          environment: processEnv,
          childProcessSpawner: spawner,
          cwd: serverConfig.stateDir,
          clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        return yield* runtime.initialize();
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

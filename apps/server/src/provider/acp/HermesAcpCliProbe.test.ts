/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 vp test run HermesAcpCliProbe
 * Set T3_HERMES_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * The probe assumes Hermes has a configured provider (`hermes setup`), so
 * `initialize` advertises a runtime-credential auth method next to the
 * terminal `hermes-setup` entry. When only `hermes-setup` is advertised the
 * runtime skips `authenticate`, matching how an unconfigured install behaves.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  HERMES_SETUP_AUTH_METHOD_ID,
  hermesSetupRequired,
  makeHermesAcpRuntime,
  resolveHermesAuthMethodId,
} from "./HermesAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeHermesAcpRuntime({
    hermesSettings: { binaryPath: "hermes" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes ACP CLI probe", () => {
  it.effect("initialize advertises a usable or setup-only auth surface", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const initialize = yield* runtime.initialize();
      expect(initialize.agentInfo?.name).toBe("hermes-agent");
      const methodId = resolveHermesAuthMethodId(initialize);
      if (methodId === undefined) {
        // Unconfigured install: only the terminal setup method may appear.
        expect(hermesSetupRequired(initialize)).toBe(true);
        expect(
          (initialize.authMethods ?? []).every(
            (method) => "type" in method && method.type === "terminal",
          ),
        ).toBe(true);
      } else {
        expect(methodId).not.toBe(HERMES_SETUP_AUTH_METHOD_ID);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts a session with Hermes modes and provider-qualified models", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");

      const modes = started.sessionSetupResult.modes;
      expect(modes).toBeDefined();
      const modeIds = (modes?.availableModes ?? []).map((mode) => mode.id);
      expect(modeIds).toContain("default");

      const models = started.sessionSetupResult.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_mode round-trips a native Hermes mode", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const current = yield* runtime.getModeState;
      const target =
        current?.availableModes.find((mode) => mode.id === "accept_edits")?.id ??
        current?.availableModes[0]?.id;
      expect(target).toBeDefined();
      if (!target) return;
      yield* runtime.request("session/set_mode", {
        sessionId: started.sessionId,
        modeId: target,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_HERMES_LIVE_TURN !== "1")(
    "finishes a real Hermes turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const runtime = yield* makeHermesAcpRuntime({
          hermesSettings: { binaryPath: "hermes" },
          environment: process.env,
          childProcessSpawner,
          cwd,
          clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
        });
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") {
            chunks.push(event.text);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: "Reply exactly HERMES_T3_OK. Do not use any tools.",
            },
          ],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("HERMES_T3_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

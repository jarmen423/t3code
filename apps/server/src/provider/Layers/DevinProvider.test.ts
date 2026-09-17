import { describe, expect, it } from "@effect/vitest";
import { DevinSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DEVIN_DEFAULT_MODEL_SLUG, type DevinAuthStatus } from "../acp/DevinAcpSupport.ts";
import {
  buildDevinModelsFromConfigOptions,
  devinSubProvider,
  makeDevinProvider,
  type DevinProbeResult,
} from "./DevinProvider.ts";

const decodeSettings = Schema.decodeSync(DevinSettings);
const instanceId = ProviderInstanceId.make("devin-test");
const driver = ProviderDriverKind.make("devin");

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {},
  authMethods: [
    {
      id: "devin-browser",
      name: "Browser sign-in",
      description: "Sign in to Devin in a browser window.",
    },
  ],
  agentInfo: { name: "affogato", version: "3000.10.31" },
} satisfies EffectAcpSchema.InitializeResponse;

const probedConfigOptions = [
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "accept-edits",
    options: [
      { name: "Code", value: "accept-edits" },
      { name: "Ask", value: "ask" },
      { name: "Plan", value: "plan" },
      { name: "Bypass", value: "bypass" },
    ],
  },
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "swe-1.5",
    options: [
      { name: "SWE 1.5", value: "swe-1.5" },
      { name: "SWE 1.5 High", value: "swe-1.5-high" },
      { name: "Claude Sonnet 4.6 High", value: "claude-sonnet-4-6-high" },
      { name: "GPT 5.4 High", value: "gpt-5.4-high" },
      { name: "Fusion Sonnet", value: "fusion-sonnet" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const probedCommands = [
  { name: "compact", description: "Compact the conversation" },
  {
    name: "model",
    description: "Show or switch the active model",
    input: { hint: "model name to switch to" },
  },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

const testLayer = Layer.merge(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  ServerSettingsService.layerTest(),
);

const makeProvider = Effect.fn("makeDevinProviderHarness")(function* (
  probeResult: Effect.Effect<DevinProbeResult, never>,
  authStatus: DevinAuthStatus = "authenticated",
) {
  const probeArgs = yield* Ref.make<ReadonlyArray<boolean>>([]);
  // The build-time check runs on a forked fiber; the gate lets the test
  // subscribe to its publish before it can complete.
  const gate = yield* Deferred.make<void>();
  const provider = yield* makeDevinProvider(decodeSettings({ enabled: true }), {
    stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
    probe: (includeSessionMetadata) =>
      Ref.update(probeArgs, (args) => [...args, includeSessionMetadata]).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(probeResult),
      ),
    probeAuthStatus: Effect.succeed(authStatus),
    supportsTextGeneration: Effect.succeed(true),
  });
  const releases = Deferred.succeed(gate, undefined).pipe(Effect.asVoid);
  return { provider, probeArgs, releases };
});

describe("devinSubProvider", () => {
  it("groups Cognition families under Devin and vendors under their names", () => {
    expect(devinSubProvider("swe-1.5")).toBe("Devin");
    expect(devinSubProvider("swe-1.5-high")).toBe("Devin");
    expect(devinSubProvider("fusion-sonnet")).toBe("Devin");
    expect(devinSubProvider("fusion-claude-opus")).toBe("Devin");
    expect(devinSubProvider("adaptive")).toBe("Devin");
    expect(devinSubProvider("claude-opus-5-high")).toBe("Claude");
    expect(devinSubProvider("gpt-5.4-high")).toBe("OpenAI");
    expect(devinSubProvider("gemini-3-pro")).toBe("Gemini");
    expect(devinSubProvider("MODEL_SWE_1_5")).toBe("Legacy");
    expect(devinSubProvider("something-else")).toBeUndefined();
  });
});

describe("buildDevinModelsFromConfigOptions", () => {
  it("puts the product default slug first and keeps native config-option models", () => {
    const models = buildDevinModelsFromConfigOptions(probedConfigOptions, []);
    expect(models.map((model) => model.slug)).toEqual([
      DEVIN_DEFAULT_MODEL_SLUG,
      "swe-1.5",
      "swe-1.5-high",
      "claude-sonnet-4-6-high",
      "gpt-5.4-high",
      "fusion-sonnet",
    ]);
    expect(models[1]?.isDefault).toBe(true);
    expect(models[1]?.subProvider).toBe("Devin");
    expect(models[3]?.subProvider).toBe("Claude");
    expect(models[4]?.subProvider).toBe("OpenAI");
    expect(models[5]?.subProvider).toBe("Devin");
  });

  it("dedupes native ids, drops blanks, and tolerates missing state", () => {
    const models = buildDevinModelsFromConfigOptions(
      [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "swe-1.5",
          options: [
            { name: "SWE 1.5", value: "swe-1.5" },
            { name: "SWE 1.5 again", value: "swe-1.5" },
            { name: "blank", value: "  " },
            { name: "", value: "other-model" },
          ],
        },
      ],
      [],
    );
    expect(models.map((model) => model.slug)).toEqual([
      DEVIN_DEFAULT_MODEL_SLUG,
      "swe-1.5",
      "other-model",
    ]);
    // An option with no display name falls back to the slug.
    expect(models[2]?.name).toBe("other-model");
    expect(buildDevinModelsFromConfigOptions(undefined, undefined).map((m) => m.slug)).toEqual([
      DEVIN_DEFAULT_MODEL_SLUG,
    ]);
  });

  it("appends custom models after native ones and dedupes them", () => {
    const models = buildDevinModelsFromConfigOptions(probedConfigOptions, [
      { slug: "swe-1.5", name: "Collides with native" },
      "extra-model",
      { slug: "gpt-5.5", name: "Custom GPT" },
      DEVIN_DEFAULT_MODEL_SLUG,
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      DEVIN_DEFAULT_MODEL_SLUG,
      "swe-1.5",
      "swe-1.5-high",
      "claude-sonnet-4-6-high",
      "gpt-5.4-high",
      "fusion-sonnet",
      "extra-model",
      "gpt-5.5",
    ]);
    expect(models[1]?.isCustom).toBe(false);
    expect(models[6]?.isCustom).toBe(true);
    expect(models[6]?.name).toBe("extra-model");
    expect(models[7]?.isCustom).toBe(true);
    expect(models[7]?.name).toBe("Custom GPT");
  });
});

describe("makeDevinProvider probe", () => {
  it.effect("seeds picker models and slash commands from a session probe while cold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, probeArgs, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            authStatus: "authenticated",
            version: "devin 3000.10.31",
            configOptions: probedConfigOptions,
            commands: probedCommands,
          }),
        );
        const pull = yield* Stream.toPull(
          provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.models.length > 1),
          ),
        );
        yield* releases;
        yield* pull;
        const snapshot = yield* provider.snapshot.refresh;
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          DEVIN_DEFAULT_MODEL_SLUG,
          "swe-1.5",
          "swe-1.5-high",
          "claude-sonnet-4-6-high",
          "gpt-5.4-high",
          "fusion-sonnet",
        ]);
        expect(snapshot.models[1]?.isDefault).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact", "model"]);
        expect(snapshot.auth.status).toBe("authenticated");
        // The cold first check opened a throwaway session; once populated,
        // checks stay initialize-only and sessions keep both lists fresh.
        expect(yield* Ref.get(probeArgs)).toEqual([true, false]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a healthy probe when the session probe yields no config options", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, probeArgs, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            authStatus: "authenticated",
            version: null,
            configOptions: undefined,
            commands: undefined,
          }),
        );
        const pull = yield* Stream.toPull(
          provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.status === "ready"),
          ),
        );
        yield* releases;
        yield* pull;
        const snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([DEVIN_DEFAULT_MODEL_SLUG]);
        yield* provider.snapshot.refresh;
        // Still cold — each check keeps asking until a session probe lands.
        expect(yield* Ref.get(probeArgs)).toEqual([true, true]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports setup-required and no native models when unauthenticated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            authStatus: "unauthenticated",
            version: null,
            configOptions: undefined,
            commands: undefined,
          }),
          "unauthenticated",
        );
        const pull = yield* Stream.toPull(
          provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.status === "warning"),
          ),
        );
        yield* releases;
        yield* pull;
        const snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("devin auth login");
        expect(snapshot.models.map((model) => model.slug)).toEqual([DEVIN_DEFAULT_MODEL_SLUG]);
        expect(snapshot.setup?.canAuthenticate).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});

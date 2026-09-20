import { describe, expect, it } from "@effect/vitest";
import { HermesSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { HERMES_DEFAULT_MODEL_SLUG } from "../acp/HermesAcpSupport.ts";
import {
  buildHermesModelsFromSession,
  makeHermesProvider,
  type HermesProbeResult,
} from "./HermesProvider.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);
const instanceId = ProviderInstanceId.make("hermes-test");
const driver = ProviderDriverKind.make("hermes");

const FALLBACK_REASONING_DESCRIPTOR = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "none", label: "Off" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultra", label: "Ultra" },
  ],
  currentValue: "high",
} as const;

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {},
  authMethods: [
    {
      id: "xai-oauth",
      name: "xai-oauth runtime credentials",
      description: "Authenticate Hermes using the configured xai-oauth credentials.",
    },
  ],
  agentInfo: { name: "hermes-agent", version: "0.21.2" },
} satisfies EffectAcpSchema.InitializeResponse;

const probedModels = {
  currentModelId: "xai-oauth:grok-4.6",
  availableModels: [
    { modelId: "xai-oauth:grok-4.6", name: "xai-oauth · grok-4.6" },
    { modelId: "openrouter:anthropic/claude", name: "openrouter · anthropic/claude" },
  ],
} satisfies EffectAcpSchema.SessionModelState;

const probedCommands = [
  { name: "help", description: "List available commands" },
  {
    name: "model",
    description: "Show current model and provider, or switch models",
    input: { hint: "model name to switch to" },
  },
  { name: "compress", description: "Compress conversation context" },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

const testLayer = Layer.merge(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  ServerSettingsService.layerTest(),
);

const makeProvider = Effect.fn("makeHermesProviderHarness")(function* (
  probeResult: Effect.Effect<HermesProbeResult, never>,
) {
  const probeArgs = yield* Ref.make<ReadonlyArray<boolean>>([]);
  // The build-time check runs on a forked fiber; the gate lets the test
  // subscribe to its publish before it can complete.
  const gate = yield* Deferred.make<void>();
  const provider = yield* makeHermesProvider(decodeSettings({ enabled: true }), {
    stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
    probe: (includeModels) =>
      Ref.update(probeArgs, (args) => [...args, includeModels]).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(probeResult),
      ),
    supportsTextGeneration: Effect.succeed(true),
  });
  const releases = Deferred.succeed(gate, undefined).pipe(Effect.asVoid);
  return { provider, probeArgs, releases };
});

describe("buildHermesModelsFromSession", () => {
  it("puts the product default slug first and keeps native models", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:anthropic/claude",
        availableModels: [
          { modelId: "openrouter:anthropic/claude", name: "Claude" },
          { modelId: "xai-oauth:grok-4", name: "Grok 4" },
        ],
      },
      [],
    );
    expect(models.map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
      "openrouter:anthropic/claude",
      "xai-oauth:grok-4",
    ]);
    expect(models[1]?.isDefault).toBe(true);
    expect(models[1]?.subProvider).toBe("openrouter");
    expect(models[2]?.subProvider).toBe("xai-oauth");
  });

  it("dedupes native ids, drops blanks, and tolerates missing state", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:a",
        availableModels: [
          { modelId: "openrouter:a", name: "A" },
          { modelId: "openrouter:a", name: "A again" },
          { modelId: "  ", name: "blank" },
          { modelId: "plain", name: "" },
        ],
      },
      [],
    );
    expect(models.map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
      "openrouter:a",
      "plain",
    ]);
    // An unqualified native id gets no sub-provider group and falls back to the slug name.
    expect(models[2]?.subProvider).toBeUndefined();
    expect(models[2]?.name).toBe("plain");

    expect(buildHermesModelsFromSession(undefined, undefined).map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
    ]);
    expect(
      buildHermesModelsFromSession(undefined, undefined)[0]?.capabilities.optionDescriptors,
    ).toEqual([FALLBACK_REASONING_DESCRIPTOR]);
  });

  it("groups `custom:<provider>:<model>` ids under the real provider", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "xai-oauth:grok-4.6",
        availableModels: [
          { modelId: "custom:cline-pass:openai/gpt-4o", name: "cline-pass · openai/gpt-4o" },
          { modelId: "zai-responses:glm-5.3-flash", name: "zai-responses · glm-5.3-flash" },
        ],
      },
      [],
    );
    expect(models[1]?.subProvider).toBe("cline-pass");
    expect(models[2]?.subProvider).toBe("zai-responses");
  });

  it("appends custom models after native ones and dedupes them against built-in slugs", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:a",
        availableModels: [{ modelId: "openrouter:a", name: "A" }],
      },
      [
        { slug: "openrouter:a", name: "Collides with native" },
        "ollama:local",
        { slug: "xai-oauth:custom-grok", name: "Custom Grok" },
        HERMES_DEFAULT_MODEL_SLUG,
      ],
    );
    expect(models.map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
      "openrouter:a",
      "ollama:local",
      "xai-oauth:custom-grok",
    ]);
    // The colliding custom entry and the product-slug duplicate are dropped;
    // the native row keeps its built-in identity.
    expect(models[1]?.isCustom).toBe(false);
    expect(models[1]?.name).toBe("A");
    expect(models[2]?.isCustom).toBe(true);
    // A bare-slug custom entry falls back to the slug for its display name.
    expect(models[2]?.name).toBe("ollama:local");
    expect(models[3]?.isCustom).toBe(true);
    expect(models[3]?.name).toBe("Custom Grok");
  });

  it("surfaces reasoningEffort metadata as a select descriptor on native models", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:a",
        availableModels: [
          {
            modelId: "openrouter:a",
            name: "A",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [
                { value: "none", label: "Off" },
                { value: "low", label: "Low" },
                { value: "high", label: "High", default: true },
                { value: "ultra", label: "Ultra" },
              ],
            },
          },
          { modelId: "openrouter:b", name: "B" },
        ],
      },
      [],
    );
    const advertised = [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "none", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultra", label: "Ultra" },
        ],
        currentValue: "high",
      },
    ];
    // The product slug stays selected in the composer, so it copies the current
    // native model's advertised ladder. Models that omit _meta still get the
    // fallback none..ultra control.
    expect(models[0]?.capabilities.optionDescriptors).toEqual(advertised);
    expect(models[1]?.capabilities.optionDescriptors).toEqual(advertised);
    expect(models[2]?.capabilities.optionDescriptors).toEqual([FALLBACK_REASONING_DESCRIPTOR]);
  });

  it("ignores malformed effort entries and an unsupported flag", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:a",
        availableModels: [
          {
            modelId: "openrouter:a",
            name: "A",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: "not-on-the-ladder",
              reasoningEfforts: [
                { value: "low", label: "Low" },
                { value: "bogus!!", label: "Bad" },
                "not-an-object",
                { value: "low", label: "Low duplicate" },
              ],
            },
          },
          {
            modelId: "openrouter:c",
            name: "C",
            _meta: {
              supportsReasoningEffort: false,
              reasoningEfforts: [{ value: "low", label: "Low" }],
            },
          },
        ],
      },
      [],
    );
    expect(models[1]?.capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "low", label: "Low" }],
      },
    ]);
    expect(models[0]?.capabilities.optionDescriptors).toEqual(
      models[1]?.capabilities.optionDescriptors,
    );
    expect(models[2]?.capabilities.optionDescriptors).toEqual([]);
  });

  it("hides reasoning on the product slug when the current model opts out", () => {
    const models = buildHermesModelsFromSession(
      {
        currentModelId: "openrouter:c",
        availableModels: [
          {
            modelId: "openrouter:c",
            name: "C",
            _meta: {
              supportsReasoningEffort: false,
              reasoningEfforts: [{ value: "low", label: "Low" }],
            },
          },
        ],
      },
      [],
    );
    expect(models[0]?.capabilities.optionDescriptors).toEqual([]);
    expect(models[1]?.capabilities.optionDescriptors).toEqual([]);
  });
});

describe("makeHermesProvider probe", () => {
  it.effect("seeds picker models and slash commands from a session probe while cold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, probeArgs, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            models: probedModels,
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
          HERMES_DEFAULT_MODEL_SLUG,
          "xai-oauth:grok-4.6",
          "openrouter:anthropic/claude",
        ]);
        expect(snapshot.models[1]?.isDefault).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
          "help",
          "model",
          "compress",
        ]);
        // The cold first check opened a throwaway session; once populated,
        // checks stay initialize-only and sessions keep both lists fresh.
        expect(yield* Ref.get(probeArgs)).toEqual([true, false]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a healthy probe when the session probe yields no models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, probeArgs, releases } = yield* makeProvider(
          Effect.succeed({ initialize: initializeResult, models: undefined, commands: undefined }),
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
        expect(snapshot.models.map((model) => model.slug)).toEqual([HERMES_DEFAULT_MODEL_SLUG]);
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
            initialize: { protocolVersion: 1, authMethods: [] },
            models: undefined,
            commands: undefined,
          }),
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
        expect(snapshot.message).toContain("hermes setup");
        expect(snapshot.models.map((model) => model.slug)).toEqual([HERMES_DEFAULT_MODEL_SLUG]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});

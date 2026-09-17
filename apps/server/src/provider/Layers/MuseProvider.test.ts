import { describe, expect, it } from "@effect/vitest";
import { MuseSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { MUSE_DEFAULT_MODEL_SLUG } from "../acp/MuseAcpSupport.ts";
import {
  buildMuseModelCapabilities,
  buildMuseModelsFromSession,
  makeMuseProvider,
  type MuseProbeResult,
} from "./MuseProvider.ts";

const decodeSettings = Schema.decodeSync(MuseSettings);
const instanceId = ProviderInstanceId.make("muse-test");
const driver = ProviderDriverKind.make("muse");

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {},
  agentInfo: { name: "muse-acp-bridge", version: "0.1.0" },
} satisfies EffectAcpSchema.InitializeResponse;

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "muse-spark-1.3",
  options: [
    { value: "muse-spark-1.3", name: "Muse Spark 1.3" },
    { value: "muse-spark-1.2", name: "Muse Spark 1.2" },
    { value: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

const groupedModelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "muse-spark-1.3",
  options: [
    {
      group: "spark",
      name: "Spark",
      options: [
        { value: "muse-spark-1.3", name: "Muse Spark 1.3" },
        { value: "muse-spark-1.2", name: "Muse Spark 1.2" },
      ],
    },
    {
      group: "contributor",
      name: "Contributor",
      options: [{ value: "muse-spark-1.3-contributor", name: "Spark 1.3 Contributor" }],
    },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

const reasoningOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "none", name: "None" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

const sessionSetup = {
  sessionId: "s1",
  configOptions: [modelOption, reasoningOption],
} satisfies EffectAcpSchema.NewSessionResponse;

const probedCommands = [
  { name: "compact", description: "Compact conversation context" },
  { name: "help", description: "List available commands", input: { hint: "topic" } },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

const testLayer = Layer.merge(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  ServerSettingsService.layerTest(),
);

const makeProvider = Effect.fn("makeMuseProviderHarness")(function* (
  probeResult: Effect.Effect<MuseProbeResult, EffectAcpErrors.AcpError>,
) {
  const probeArgs = yield* Ref.make<ReadonlyArray<boolean>>([]);
  // The build-time check runs on a forked fiber; the gate lets the test
  // subscribe to its publish before it can complete.
  const gate = yield* Deferred.make<void>();
  const provider = yield* makeMuseProvider(decodeSettings({ enabled: true }), {
    stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
    probe: (includeSessionMetadata) =>
      Ref.update(probeArgs, (args) => [...args, includeSessionMetadata]).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(probeResult),
      ),
    supportsTextGeneration: Effect.succeed(true),
  });
  const releases = Deferred.succeed(gate, undefined).pipe(Effect.asVoid);
  return { provider, probeArgs, releases };
});

describe("buildMuseModelCapabilities", () => {
  it("turns the reasoning_effort select option into a reasoningEffort descriptor", () => {
    expect(buildMuseModelCapabilities(reasoningOption).optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "none", label: "None" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
      },
    ]);
  });

  it("drops malformed values and non-select options", () => {
    const malformed = {
      ...reasoningOption,
      currentValue: "bogus!!",
      options: [
        { value: "bogus!!", name: "Bad" },
        { value: "high", name: "High" },
      ],
    } satisfies EffectAcpSchema.SessionConfigOption;
    expect(buildMuseModelCapabilities(malformed).optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High" }],
      },
    ]);
    expect(buildMuseModelCapabilities(undefined).optionDescriptors).toEqual([]);
    expect(
      buildMuseModelCapabilities({
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "boolean",
        currentValue: true,
      }).optionDescriptors,
    ).toEqual([]);
  });
});

describe("buildMuseModelsFromSession", () => {
  it("puts the product default slug first and keeps native models", () => {
    const models = buildMuseModelsFromSession(sessionSetup, []);
    expect(models.map((model) => model.slug)).toEqual([
      MUSE_DEFAULT_MODEL_SLUG,
      "muse-spark-1.3",
      "muse-spark-1.2",
      "muse-spark-1.3-contributor",
    ]);
    expect(models[1]?.isDefault).toBe(true);
    expect(models[1]?.subProvider).toBeUndefined();
  });

  it("carries a select group name as the sub-provider label", () => {
    const models = buildMuseModelsFromSession(
      { sessionId: "s1", configOptions: [groupedModelOption] },
      [],
    );
    expect(models.map((model) => model.slug)).toEqual([
      MUSE_DEFAULT_MODEL_SLUG,
      "muse-spark-1.3",
      "muse-spark-1.2",
      "muse-spark-1.3-contributor",
    ]);
    expect(models[1]?.subProvider).toBe("Spark");
    expect(models[2]?.subProvider).toBe("Spark");
    expect(models[3]?.subProvider).toBe("Contributor");
  });

  it("attaches the shared reasoning ladder to native models only", () => {
    const models = buildMuseModelsFromSession(sessionSetup, []);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "none", label: "None" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
      },
    ]);
  });

  it("dedupes native ids, drops blanks, and tolerates missing state", () => {
    const models = buildMuseModelsFromSession(
      {
        sessionId: "s1",
        configOptions: [
          {
            ...modelOption,
            options: [
              { value: "muse-spark-1.3", name: "Spark" },
              { value: "muse-spark-1.3", name: "Spark again" },
              { value: "  ", name: "blank" },
              { value: "plain", name: "" },
            ],
          },
        ],
      },
      [],
    );
    expect(models.map((model) => model.slug)).toEqual([
      MUSE_DEFAULT_MODEL_SLUG,
      "muse-spark-1.3",
      "plain",
    ]);
    expect(models[2]?.name).toBe("plain");
    expect(buildMuseModelsFromSession(undefined, undefined).map((model) => model.slug)).toEqual([
      MUSE_DEFAULT_MODEL_SLUG,
    ]);
  });

  it("appends custom models after native ones and dedupes built-in slugs", () => {
    const models = buildMuseModelsFromSession(sessionSetup, [
      { slug: "muse-spark-1.2", name: "Collides with native" },
      "muse-community-9",
      MUSE_DEFAULT_MODEL_SLUG,
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      MUSE_DEFAULT_MODEL_SLUG,
      "muse-spark-1.3",
      "muse-spark-1.2",
      "muse-spark-1.3-contributor",
      "muse-community-9",
    ]);
    const custom = models.at(-1);
    expect(custom?.isCustom).toBe(true);
    expect(custom?.name).toBe("muse-community-9");
  });
});

describe("makeMuseProvider probe", () => {
  it.effect("seeds models and slash commands from a session probe while cold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, probeArgs, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            session: { setup: sessionSetup, commands: probedCommands },
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
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "host",
          label: "muse login",
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          MUSE_DEFAULT_MODEL_SLUG,
          "muse-spark-1.3",
          "muse-spark-1.2",
          "muse-spark-1.3-contributor",
        ]);
        expect(snapshot.models[1]?.isDefault).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact", "help"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        // The cold first check opened a throwaway session; once populated,
        // checks stay initialize-only and sessions keep both lists fresh.
        expect(yield* Ref.get(probeArgs)).toEqual([true, false]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports setup-required and no native models when auth is required", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, releases } = yield* makeProvider(
          Effect.succeed({
            initialize: initializeResult,
            session: { authRequired: true },
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
        expect(snapshot.message).toContain("muse login");
        expect(snapshot.models.map((model) => model.slug)).toEqual([MUSE_DEFAULT_MODEL_SLUG]);
        expect(snapshot.supportsTextGeneration).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a healthy probe when the session probe fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, releases } = yield* makeProvider(
          Effect.succeed({ initialize: initializeResult, session: { failed: true } }),
        );
        const pull = yield* Stream.toPull(
          provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.status === "warning"),
          ),
        );
        yield* releases;
        yield* pull;
        const snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.installed).toBe(true);
        expect(snapshot.message).toContain("session check failed");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("marks the provider uninstalled when the bridge binary is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, releases } = yield* makeProvider(
          Effect.fail(new EffectAcpErrors.AcpSpawnError({ cause: { code: "ENOENT" } })),
        );
        const pull = yield* Stream.toPull(
          provider.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.status === "error"),
          ),
        );
        yield* releases;
        yield* pull;
        const snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.installed).toBe(false);
        expect(snapshot.message).toContain("not installed");
        expect(snapshot.models).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});

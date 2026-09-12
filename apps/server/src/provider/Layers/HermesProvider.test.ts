import { describe, expect, it } from "@effect/vitest";

import { HERMES_DEFAULT_MODEL_SLUG } from "../acp/HermesAcpSupport.ts";
import { buildHermesModelsFromSession } from "./HermesProvider.ts";

describe("buildHermesModelsFromSession", () => {
  it("puts the product default slug first and keeps native models", () => {
    const models = buildHermesModelsFromSession({
      currentModelId: "openrouter:anthropic/claude",
      availableModels: [
        { modelId: "openrouter:anthropic/claude", name: "Claude" },
        { modelId: "xai-oauth:grok-4", name: "Grok 4" },
      ],
    });
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
    const models = buildHermesModelsFromSession({
      currentModelId: "openrouter:a",
      availableModels: [
        { modelId: "openrouter:a", name: "A" },
        { modelId: "openrouter:a", name: "A again" },
        { modelId: "  ", name: "blank" },
        { modelId: "plain", name: "" },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
      "openrouter:a",
      "plain",
    ]);
    // An unqualified native id gets no sub-provider group and falls back to the slug name.
    expect(models[2]?.subProvider).toBeUndefined();
    expect(models[2]?.name).toBe("plain");

    expect(buildHermesModelsFromSession(undefined).map((model) => model.slug)).toEqual([
      HERMES_DEFAULT_MODEL_SLUG,
    ]);
  });
});

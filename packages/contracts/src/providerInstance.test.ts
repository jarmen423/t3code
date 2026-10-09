import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings } from "./settings.ts";
import {
  PROVIDER_INSTANCE_ICON_MAX_CHARS,
  PROVIDER_INSTANCE_ICON_MAX_DECODED_BYTES,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceIcon,
  ProviderInstanceId,
  ProviderInstanceRef,
  resolveProviderInstanceIcon,
} from "./providerInstance.ts";

const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeProviderInstanceRef = Schema.decodeUnknownSync(ProviderInstanceRef);
const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeProviderInstanceConfig = Schema.encodeSync(ProviderInstanceConfig);
const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const decodeProviderInstanceIcon = Schema.decodeUnknownSync(ProviderInstanceIcon);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const PNG_ICON = "data:image/png;base64,AAAA";
const SVG_ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function oversizedDataIcon(): string {
  const decodedBytes = PROVIDER_INSTANCE_ICON_MAX_DECODED_BYTES + 1;
  const payloadLength = Math.ceil(decodedBytes / 3) * 4;
  return `data:image/png;base64,${"A".repeat(payloadLength)}`;
}

describe("provider slug validation (shared by driver + instance ids)", () => {
  const cases = [
    { schemaName: "ProviderInstanceId", decode: decodeProviderInstanceId },
    { schemaName: "ProviderDriverKind", decode: decodeProviderDriverKind },
  ] as const;

  describe.each(cases)("$schemaName", ({ decode }) => {
    it.each(["codex", "codex_personal", "codex-work", "claudeAgent", "x", "abc123", "ollama"])(
      "accepts %s",
      (id) => {
        expect(decode(id)).toBe(id);
      },
    );

    it.each([
      ["empty string", ""],
      ["leading digit", "1codex"],
      ["leading dash", "-codex"],
      ["leading underscore", "_codex"],
      ["whitespace inside", "codex personal"],
      ["dot inside", "codex.personal"],
      ["slash inside", "codex/personal"],
    ])("rejects %s", (_label, value) => {
      expect(() => decode(value)).toThrow();
    });

    it("trims surrounding whitespace before validating", () => {
      expect(decode("  codex_work  ")).toBe("codex_work");
    });

    it("rejects ids longer than 64 characters", () => {
      const tooLong = "a".repeat(65);
      expect(() => decode(tooLong)).toThrow();
      const justRight = "a".repeat(64);
      expect(decode(justRight)).toBe(justRight);
    });
  });
});

describe("ProviderInstanceRef", () => {
  it("decodes a driver ref", () => {
    const ref = decodeProviderInstanceRef({
      instanceId: "codex_work",
      driver: "codex",
    });
    expect(ref.instanceId).toBe("codex_work");
    expect(ref.driver).toBe("codex");
  });

  it("decodes a fork-defined driver ref without complaint", () => {
    const ref = decodeProviderInstanceRef({
      instanceId: "ollama_local",
      driver: "ollama",
    });
    expect(ref.instanceId).toBe("ollama_local");
    expect(ref.driver).toBe("ollama");
  });

  it("rejects refs whose driver field is not a valid slug", () => {
    expect(() =>
      decodeProviderInstanceRef({
        instanceId: "codex",
        driver: "1nope",
      }),
    ).toThrow();
  });
});

describe("ProviderInstanceConfig", () => {
  it("accepts a minimal config envelope for a driver", () => {
    const decoded = decodeProviderInstanceConfig({ driver: "codex" });
    expect(decoded.driver).toBe("codex");
    expect(decoded.displayName).toBeUndefined();
    expect(decoded.enabled).toBeUndefined();
    expect(decoded.config).toBeUndefined();
  });

  it("preserves driver-opaque config payloads verbatim", () => {
    const opaqueConfig = { homePath: "~/.codex_personal", binaryPath: "codex" };
    const decoded = decodeProviderInstanceConfig({
      driver: "codex",
      displayName: "Codex (personal)",
      accentColor: "#dc2626",
      enabled: true,
      config: opaqueConfig,
    });
    expect(decoded.displayName).toBe("Codex (personal)");
    expect(decoded.accentColor).toBe("#dc2626");
    expect(decoded.enabled).toBe(true);
    expect(decoded.config).toEqual(opaqueConfig);
  });

  it("trims provider instance envelope fields", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "  codex  ",
      displayName: "  Codex Personal  ",
      accentColor: "  #dc2626  ",
      environment: [{ name: "  OPENROUTER_API_KEY  ", value: "  sk-or-test  " }],
    });

    expect(decoded).toMatchObject({
      driver: "codex",
      displayName: "Codex Personal",
      accentColor: "#dc2626",
      environment: [{ name: "OPENROUTER_API_KEY", value: "  sk-or-test  " }],
    });
  });

  it("decodes generic environment variables on the instance envelope", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "claudeAgent",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
    });

    expect(decoded.environment).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
    ]);
  });

  it("rejects invalid environment variable names", () => {
    expect(() =>
      decodeProviderInstanceConfig({
        driver: "codex",
        environment: [{ name: "HAS-DASH", value: "x", sensitive: false }],
      }),
    ).toThrow();
  });

  it("decodes envelopes that name an unknown driver and preserves their config opaquely", () => {
    const opaqueConfig = { someUnknownKnob: 42, model: "llama3" };
    const decoded = decodeProviderInstanceConfig({
      driver: "ollama",
      displayName: "Ollama",
      enabled: true,
      config: opaqueConfig,
    });
    expect(decoded.driver).toBe("ollama");
    expect(decoded.config).toEqual(opaqueConfig);
  });

  it("rejects a blank displayName (must be trimmed non-empty)", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "codex", displayName: "   " })).toThrow();
  });

  it("rejects driver values that do not satisfy the slug pattern", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "" })).toThrow();
    expect(() => decodeProviderInstanceConfig({ driver: "has spaces" })).toThrow();
  });
});

describe("ProviderInstanceIcon", () => {
  it("accepts base64 PNG and SVG data URIs and https URLs", () => {
    expect(decodeProviderInstanceIcon(PNG_ICON)).toBe(PNG_ICON);
    expect(decodeProviderInstanceIcon(`  ${SVG_ICON}  `)).toBe(SVG_ICON);
    expect(decodeProviderInstanceIcon("HTTPS://cdn.example.com/fred.png")).toBe(
      "https://cdn.example.com/fred.png",
    );
    expect(resolveProviderInstanceIcon(PNG_ICON)).toBe(PNG_ICON);
  });

  it("round-trips through a provider instance and through settings when absent", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "acpRegistry",
      displayName: "Fred",
      icon: PNG_ICON,
    });
    expect(decoded.icon).toBe(PNG_ICON);
    expect(encodeProviderInstanceConfig(decoded).icon).toBe(PNG_ICON);

    const withoutIcon = decodeProviderInstanceConfig({ driver: "codex", accentColor: "#dc2626" });
    expect(withoutIcon.icon).toBeUndefined();
    expect(encodeProviderInstanceConfig(withoutIcon)).not.toHaveProperty("icon");

    const settings = decodeServerSettings({
      providerInstances: {
        grok_bot: { driver: "acpRegistry", displayName: "Fred", icon: SVG_ICON },
        codex: { driver: "codex" },
      },
    });
    expect(settings.providerInstances[ProviderInstanceId.make("grok_bot")]?.icon).toBe(SVG_ICON);
    expect(settings.providerInstances[ProviderInstanceId.make("codex")]?.icon).toBeUndefined();
  });

  it.each([
    ["javascript URL", "javascript:alert(1)"],
    ["http URL", "http://cdn.example.com/fred.png"],
    ["credentialed https URL", "https://user:secret@cdn.example.com/fred.png"],
    ["html data URI", "data:text/html;base64,PHNjcmlwdD4="],
    ["unencoded svg data URI", "data:image/svg+xml,<svg onload='alert(1)'></svg>"],
    ["non-base64 png data URI", "data:image/png,not-base64"],
    ["empty string", ""],
    ["oversized data URI", oversizedDataIcon()],
    [
      "oversized https URL",
      `https://cdn.example.com/${"a".repeat(PROVIDER_INSTANCE_ICON_MAX_CHARS)}`,
    ],
  ])("rejects %s", (_label, value) => {
    expect(resolveProviderInstanceIcon(value)).toBeNull();
    expect(() => decodeProviderInstanceIcon(value)).toThrow();
    expect(() => decodeProviderInstanceConfig({ driver: "acpRegistry", icon: value })).toThrow();
  });
});

describe("ProviderInstanceConfigMap", () => {
  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeProviderInstanceConfigMap({
      codex_personal: {
        driver: "codex",
        displayName: "Codex (personal)",
        config: { homePath: "~/.codex_personal" },
      },
      codex_work: {
        driver: "codex",
        config: { homePath: "~/.codex_work" },
      },
      claudeAgent: { driver: "claudeAgent" },
      ollama_local: { driver: "ollama", config: { endpoint: "http://localhost:11434" } },
    });
    expect(new Set(Object.keys(decoded))).toEqual(
      new Set(["claudeAgent", "codex_personal", "codex_work", "ollama_local"]),
    );
    expect(decoded[ProviderInstanceId.make("codex_personal")]?.driver).toBe("codex");
    expect(decoded[ProviderInstanceId.make("codex_work")]?.config).toEqual({
      homePath: "~/.codex_work",
    });
    expect(decoded[ProviderInstanceId.make("ollama_local")]?.driver).toBe("ollama");
  });

  it("rejects keys that fail the instance-id pattern", () => {
    expect(() =>
      decodeProviderInstanceConfigMap({
        "1codex": { driver: "codex" },
      }),
    ).toThrow();
  });
});

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyProviderInstanceIcon } from "./providerInstanceIcon.ts";

const PNG_ICON = "data:image/png;base64,AAAA";

function snapshot(patch: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("grok_bot"),
    driver: ProviderDriverKind.make("acpRegistry"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-09T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

describe("applyProviderInstanceIcon", () => {
  it("stamps a local instance icon without replacing a registry icon URL", () => {
    const registryIcon = "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg";
    const provider = snapshot({ iconUrl: registryIcon });
    const stamped = applyProviderInstanceIcon(provider, PNG_ICON);
    expect(stamped.instanceIcon).toBe(PNG_ICON);
    expect(stamped.iconUrl).toBe(registryIcon);
    expect(applyProviderInstanceIcon(stamped, PNG_ICON)).toBe(stamped);
  });

  it("leaves registry and built-in snapshots unchanged when no icon is configured", () => {
    const local = snapshot();
    const codex = snapshot({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
    });
    expect(applyProviderInstanceIcon(local, undefined)).toBe(local);
    expect(applyProviderInstanceIcon(codex, undefined).instanceIcon).toBeUndefined();
    expect(applyProviderInstanceIcon(codex, "javascript:alert(1)")).toBe(codex);
  });

  it("drops a previously stamped icon when the setting is cleared or unsafe", () => {
    const stamped = applyProviderInstanceIcon(snapshot(), PNG_ICON);
    expect(applyProviderInstanceIcon(stamped, undefined).instanceIcon).toBeUndefined();
    expect(applyProviderInstanceIcon(stamped, "http://example.com/fred.png").instanceIcon).toBe(
      undefined,
    );
  });
});

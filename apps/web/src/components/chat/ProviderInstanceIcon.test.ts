import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveProviderInstanceAcpRegistryIconUrl,
  selectProviderInstanceIcon,
} from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("does not resolve registry icons for other provider drivers", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });
});

describe("selectProviderInstanceIcon", () => {
  const png = "data:image/png;base64,AAAA";

  it("uses a local ACP instance icon and falls back to the generic glyph without one", () => {
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        instanceIcon: png,
        registryIconUrl: "https://example.com/not-official.svg",
        registryAgentId: "generic-agent",
      }),
    ).toEqual({ kind: "instance", src: png });
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        instanceIcon: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("keeps registry agents on the CDN allowlist unless that instance sets an icon", () => {
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        registryAgentId: "generic-agent",
        registryIconUrl: "https://example.com/not-official.svg",
      }),
    ).toEqual({
      kind: "registry",
      src: "https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg",
    });
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        instanceIcon: "https://cdn.example.com/fred.png",
        registryAgentId: "generic-agent",
        registryIconUrl: "https://cdn.agentclientprotocol.com/registry/icons/generic-agent.svg",
      })?.kind,
    ).toBe("instance");
  });

  it("leaves built-in providers on their glyphs unless an instance icon is set", () => {
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("codex"),
        registryAgentId: "kilo",
        registryIconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBeNull();
    expect(
      selectProviderInstanceIcon({
        driverKind: ProviderDriverKind.make("codex"),
        instanceIcon: png,
      }),
    ).toEqual({ kind: "instance", src: png });
  });
});

import { type CSSProperties, memo, useState } from "react";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind, resolveProviderInstanceIcon } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DevinIcon,
  HermesIcon,
  GrokIcon,
  MuseIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("muse")]: MuseIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("hermes")]: HermesIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("cursor")]: "text-[#26251E] dark:text-[#EDECEC]",
  [ProviderDriverKind.make("grok")]: "text-[#0F0F0F] dark:text-[#F5F5F5]",
  [ProviderDriverKind.make("opencode")]: "text-[#211E1E] dark:text-[#F1ECEC]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
};

/** Brand text color for a provider label; package glyphs supply theirs as CSS variables. */
export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  const className = PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
  return className ? { className } : {};
}

export function resolveProviderInstanceAcpRegistryIconUrl(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly iconUrl?: string | undefined;
}): string | null {
  if (input.driverKind !== "acpRegistry") return null;
  return (
    resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null) ??
    officialAcpRegistryIconUrlForAgentId(input.agentId?.trim() || null)
  );
}

/**
 * Pick the image to draw for one provider instance.
 *
 * A configured instance icon wins for that instance only. Registry icons
 * still go through the official CDN allowlist, and other drivers keep their
 * built-in glyphs when no instance icon is set.
 */
export function selectProviderInstanceIcon(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceIcon?: string | null | undefined;
  readonly registryIconUrl?: string | null | undefined;
  readonly registryAgentId?: string | null | undefined;
}): { readonly kind: "instance" | "registry"; readonly src: string } | null {
  const instanceIcon = resolveProviderInstanceIcon(input.instanceIcon);
  if (instanceIcon !== null) return { kind: "instance", src: instanceIcon };
  const registryIcon = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: input.driverKind,
    iconUrl: input.registryIconUrl ?? undefined,
    agentId: input.registryAgentId ?? undefined,
  });
  return registryIcon === null ? null : { kind: "registry", src: registryIcon };
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  instanceIcon?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const packageIcon = providerClients.get(props.driverKind)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const selectedIcon = selectProviderInstanceIcon({
    driverKind: props.driverKind,
    instanceIcon: props.instanceIcon,
    registryIconUrl: props.acpRegistryIconUrl,
    registryAgentId: props.acpRegistryAgentId,
  });
  const [failedInstanceIcon, setFailedInstanceIcon] = useState<string | null>(null);
  const instanceIcon =
    selectedIcon?.kind === "instance" && failedInstanceIcon !== selectedIcon.src
      ? selectedIcon.src
      : null;
  const acpRegistryIconUrl =
    instanceIcon === null && selectedIcon?.kind === "registry"
      ? selectedIcon.src
      : instanceIcon === null
        ? resolveProviderInstanceAcpRegistryIconUrl({
            driverKind: props.driverKind,
            agentId: props.acpRegistryAgentId,
            iconUrl: props.acpRegistryIconUrl,
          })
        : null;
  const isAcpRegistry = acpRegistryIconUrl !== null || props.driverKind === "acpRegistry";

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {instanceIcon !== null ? (
        <img
          alt=""
          aria-hidden
          className={cn("size-5 shrink-0 object-contain", props.iconClassName)}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          src={instanceIcon}
          onError={() => setFailedInstanceIcon(instanceIcon)}
        />
      ) : isAcpRegistry ? (
        <AcpRegistryAgentIcon
          // The search-tile radius would crop most of the glyph at these
          // inline sizes.
          className={cn("size-5 rounded-none bg-transparent", props.iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn("size-5 shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-(--provider-accent) text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
});

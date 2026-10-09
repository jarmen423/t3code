import { resolveProviderInstanceIcon, type ServerProvider } from "@t3tools/contracts";

/**
 * Stamp a user-configured instance icon onto a provider snapshot.
 *
 * `iconUrl` stays the driver-supplied registry image and keeps its own
 * allowlist. This field is only the icon from provider-instance settings.
 * Invalid values are dropped rather than published.
 */
export function applyProviderInstanceIcon(
  snapshot: ServerProvider,
  icon: string | null | undefined,
): ServerProvider {
  const instanceIcon = resolveProviderInstanceIcon(icon);
  if (instanceIcon === null) {
    if (snapshot.instanceIcon === undefined) return snapshot;
    const { instanceIcon: _dropped, ...rest } = snapshot;
    return rest;
  }
  if (snapshot.instanceIcon === instanceIcon) return snapshot;
  return { ...snapshot, instanceIcon };
}

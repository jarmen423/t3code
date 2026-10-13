/**
 * Hermes's client definition: settings form and label. Browser- and React
 * Native-safe.
 *
 * No `icon` here: the Hermes glyph is a raster PNG, which the package icon
 * format (SVG paths) cannot carry, so each client still draws it itself —
 * `HermesIcon` on web, `assets/hermes.png` on mobile.
 *
 * @module provider-hermes/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { HermesSettings } from "./settings.ts";

export const hermesClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("hermes"),
  label: "Hermes",
  badgeLabel: "Experimental",
  settingsSchema: HermesSettings,
});

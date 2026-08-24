/**
 * Beckett v6 — the extension boundary (`src/ext/`)
 * =======================================================================================
 * Public barrel for the v6 extension contract + registry (issue #82). This is the ONE seam
 * every v6 organ registers through — the "plug n play" interface described in
 * {@link ../../docs/v6-architecture.md}. LIVE since the v6 boot wiring: `shell/main.ts` holds
 * the ONE runtime instance and the concierge serves `ext.invoke`/`ext.catalog` from it over
 * the control bus; organs migrate onto it phase by phase (docs §6).
 */

export * from "./contract.ts";
export { ExtensionRegistry, renderCatalogBlock } from "./registry.ts";
export { asCapability } from "./compat.ts";
export { createPingExtension } from "./example.ts";

/*
 * The §3a SURFACE MANIFEST — the single, authoritative list of every navigable portal
 * surface that an e2e spec must cover. The deterministic aspect `portal/every-surface-has-e2e`
 * reads THIS list (by parsing the exported SURFACE_MANIFEST array) and verifies that every
 * entry is named in at least one spec's exported `COVERS` marker. Adding a surface here
 * without a covering spec is a blocking refusal; that is the point.
 *
 * Each id maps to a §3a surface:
 *   V1–V10 full views  → overview / coverage / tree / relations / structure / rulebook / types /
 *                         flows / suppressions / start
 *   SHELL              → shell-nav (persistent left navigation rail) /
 *                         shell-panel (Node Attestation) / shell-refresh / shell-approve /
 *                         shell-theme / shell-deeplink / shell-prov (provenance/freshness pins)
 *   OVERLAYS           → ov-palette (⌘K) / ov-glossary / ov-approve (cost preview)
 *
 * Keep this list and §3a A (surface inventory) in lock-step.
 */
export const SURFACE_MANIFEST = [
  // Full views V1–V9.
  'overview',
  'coverage',
  'tree',
  'relations',
  'structure',
  'rulebook',
  'types',
  'flows',
  'suppressions',
  'start',
  // Persistent shell.
  'shell-nav',
  'shell-panel',
  'shell-refresh',
  'shell-approve',
  'shell-theme',
  'shell-deeplink',
  'shell-prov',
  // Overlays.
  'ov-palette',
  'ov-glossary',
  'ov-approve',
] as const;

export type SurfaceId = (typeof SURFACE_MANIFEST)[number];

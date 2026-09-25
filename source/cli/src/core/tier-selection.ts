import type { AspectDef, ReviewerConfig, LlmConfig } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';

export type TierSelectionResult =
  | { ok: true; tier: LlmConfig; tierName: string }
  | { ok: false; error: IssueMessage };

/**
 * Pure tier resolution. Defensive: validator catches these failure
 * modes earlier in normal flow; the Result form is for tests and any
 * code path that bypasses validation.
 */
export function selectTierForAspect(
  aspect: AspectDef,
  reviewer: ReviewerConfig,
): TierSelectionResult {
  if (aspect.reviewer.type !== 'llm') {
    return {
      ok: false,
      error: {
        what: `Internal error: tried to resolve a reviewer tier for aspect '${aspect.id}', which is not a reviewer rule.`,
        why: 'This indicates an internal bug — a script rule should never need a reviewer tier.',
        next: 'Re-run yg check; if it persists, report it.',
      },
    };
  }

  const tierNames = Object.keys(reviewer.tiers);
  if (tierNames.length === 0) {
    return {
      ok: false,
      error: {
        what: 'reviewer.tiers is empty',
        why: 'at least one tier must be configured for reviewer rules to run',
        next: 'add a tier under reviewer.tiers in yg-config.yaml',
      },
    };
  }

  if (aspect.reviewer.tier !== undefined) {
    const tier = reviewer.tiers[aspect.reviewer.tier];
    if (!tier) {
      return {
        ok: false,
        error: {
          what: `aspect '${aspect.id}' references tier '${aspect.reviewer.tier}' not in config`,
          why: 'aspect.reviewer.tier must match a key under reviewer.tiers',
          next: `use one of: ${tierNames.join(', ')}, or remove tier: to use the default`,
        },
      };
    }
    return { ok: true, tier, tierName: aspect.reviewer.tier };
  }

  const defaultName =
    reviewer.default ?? (tierNames.length === 1 ? tierNames[0] : undefined);
  if (!defaultName) {
    return {
      ok: false,
      error: {
        what: `aspect '${aspect.id}' has no tier and reviewer.default is unset`,
        why: 'default is required when multiple tiers are configured',
        next: `set reviewer.default to one of: ${tierNames.join(', ')}`,
      },
    };
  }
  const defaultTier = reviewer.tiers[defaultName];
  if (!defaultTier) {
    return {
      ok: false,
      error: {
        what: `reviewer.default references unknown tier '${defaultName}'`,
        why: 'default must reference an existing tier in reviewer.tiers',
        next: `use one of: ${tierNames.join(', ')}`,
      },
    };
  }
  return { ok: true, tier: defaultTier, tierName: defaultName };
}

import path from 'node:path';
import type { Graph, GraphNode, AspectStatus } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { statPath, fileExistsSync } from '../../io/graph-fs.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses, getAspectStatusSources, type AttachSource } from '../graph/aspects.js';
import { aspectStatusDowngradeMessage } from '../../formatters/aspect-status-messages.js';
import { issueMsg } from './shared.js';
import { toPosixPath } from '../../utils/posix.js';
import { computeExpectedPairs } from '../pairs.js';
import type { TypeCoverageInput } from '../pairs.js';

// --- aspect-rule-sources: content.md vs check.mjs mutual exclusion ---

function companionWithCheckIssue(aspectId: string): ValidationIssue {
  return {
    severity: 'error',
    code: 'aspect-companion-with-check',
    rule: 'aspect-rule-sources',
    ...issueMsg({
      what: `Aspect '${aspectId}' has companion.mjs together with check.mjs.`,
      why: `companion.mjs is an add-on for LLM aspects only; it is incompatible with the deterministic check.mjs runner.`,
      next: `Remove companion.mjs from .yggdrasil/aspects/${aspectId}/ or convert the aspect to an LLM aspect (replace check.mjs with content.md).`,
    }),
  };
}

export function checkAspectRuleSources(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const aspect of graph.aspects) {
    const reviewer = aspect.reviewer.type;

    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
    const hasContentMd = fileExistsSync(path.join(aspectDir, 'content.md'));
    const hasCheckMjs = fileExistsSync(path.join(aspectDir, 'check.mjs'));
    const hasCompanionMjs = fileExistsSync(path.join(aspectDir, 'companion.mjs'));

    // Aggregating aspect: ships NEITHER content.md NOR check.mjs and only bundles
    // implied aspects. It carries no own reviewer or verdict.
    if (reviewer === 'aggregate') {
      if (hasContentMd || hasCheckMjs) {
        const present = [hasContentMd ? 'content.md' : null, hasCheckMjs ? 'check.mjs' : null]
          .filter((f): f is string => f !== null)
          .join(' and ');
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' is an aggregating aspect (no reviewer.type declared, only implies) but ships ${present}.`,
            why: `Aggregating aspects bundle implied aspects and have no own reviewer; a rule source here is never read.`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/${present} to keep it aggregating, or declare reviewer.type explicitly to make it an LLM/deterministic aspect.`,
          }),
        });
      }
      // companion.mjs is an LLM-only add-on; it is never valid on an aggregate.
      if (hasCompanionMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-companion-without-content',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has companion.mjs but no content.md.`,
            why: `companion.mjs is an add-on for LLM aspects; it requires content.md as the primary rule source.`,
            next: `Add content.md to .yggdrasil/aspects/${aspect.id}/ or remove companion.mjs.`,
          }),
        });
      }
      // An aggregate must actually bundle something — otherwise it does nothing.
      if (!aspect.implies || aspect.implies.length === 0) {
        issues.push({
          severity: 'error',
          code: 'aspect-empty',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has no content.md, no check.mjs, and no implies — it does nothing.`,
            why: `An aspect must ship a rule source (content.md or check.mjs) or aggregate others via implies; an empty aspect can never produce a verdict.`,
            next: `Add a content.md (llm) or check.mjs (deterministic), or add 'implies:' to .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml to bundle existing aspects.`,
          }),
        });
      }
      continue;
    }

    if (reviewer !== 'deterministic' && reviewer !== 'llm') continue; // covered by enum check

    if (hasContentMd && hasCheckMjs) {
      issues.push({
        severity: 'error',
        code: 'aspect-both-rule-sources',
        rule: 'aspect-rule-sources',
        ...issueMsg({
          what: `Aspect '${aspect.id}' has both content.md and check.mjs.`,
          why: `Exactly one rule source is allowed per aspect; the validator cannot infer intent.`,
          next: `Remove the file that does not match aspect's reviewer field (currently '${reviewer}').`,
        }),
      });
      // Also flag the wrong file type for the declared reviewer
      if (reviewer === 'llm') {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the deterministic reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'deterministic'.`,
          }),
        });
      } else {
        // reviewer === 'deterministic'
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but content.md is present.`,
            why: `Deterministic aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
      // companion+check is the more-specific conflict; emit it here before the continue.
      if (hasCompanionMjs) {
        issues.push(companionWithCheckIssue(aspect.id));
      }
      continue;
    }

    if (reviewer === 'llm') {
      if (!hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but content.md is missing.`,
            why: `LLM aspects need content.md as the rule definition the reviewer reads.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/content.md describing the rule.`,
          }),
        });
      }
      if (hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the deterministic reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'deterministic'.`,
          }),
        });
      }
    } else {
      // reviewer === 'deterministic'
      if (!hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but check.mjs is missing.`,
            why: `Deterministic aspects need check.mjs as the rule definition the structure runner executes.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/check.mjs exporting a check function.`,
          }),
        });
      }
      if (hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but content.md is present.`,
            why: `Deterministic aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
    }

    // companion.mjs validation — checked after the main rule-source checks.
    // Precedence: companion+check is the more-specific code; when both apply,
    // emit ONLY aspect-companion-with-check (NOT also aspect-companion-without-content).
    if (hasCompanionMjs) {
      if (hasCheckMjs) {
        issues.push(companionWithCheckIssue(aspect.id));
      } else if (!hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-companion-without-content',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has companion.mjs but no content.md.`,
            why: `companion.mjs is an add-on for LLM aspects; it requires content.md as the primary rule source.`,
            next: `Add content.md to .yggdrasil/aspects/${aspect.id}/ or remove companion.mjs.`,
          }),
        });
      }
    }
  }

  return issues;
}

// --- config-reviewer-missing: reviewer section must exist in yg-config.yaml ---

export async function checkReviewerPresence(
  graph: Graph,
  typeCoverage?: TypeCoverageInput,
): Promise<ValidationIssue[]> {
  if (graph.configError) return [];
  if (graph.config.reviewer) return [];
  // Cheap necessary-condition guard: with no LLM aspect defined at all there can
  // be no LLM pair, so skip the O(nodes²) pair walk. This is the steady state for
  // a script-only / keyless project (the CI hot path), which must not pay the full
  // enumeration on every check. Status is intentionally NOT considered here — the
  // guard must stay sound (never skip when an LLM pair could exist); the accurate
  // draft/effectiveness decision happens in computeExpectedPairs below.
  if (!graph.aspects.some((a) => a.reviewer.type === 'llm')) return [];
  // A reviewer tier is required only once a judgment (LLM) rule is actually
  // effective. Compute effective, non-draft pairs through the canonical
  // single-source query (draft is excluded by default) and stay silent when no
  // LLM pair exists — a script-only / empty graph is a legal keyless state.
  // `typeCoverage` (the SAME earlyTypeCoverage runCheck classified once, K15):
  // a repo with reviewer unconfigured and an LLM rule effective ONLY on
  // type-covered files (zero component LLM pairs) must still be caught here.
  const { pairs } = await computeExpectedPairs(graph, { typeCoverage });
  if (!pairs.some((p) => p.kind === 'llm')) return [];
  const msgData: IssueMessage = {
    what: 'A judgment rule has no judge: yg-config.yaml has no reviewer: section.',
    why: 'Script rules run locally for free, but a judgment rule (content.md) needs a configured model to read it — until then its pairs stay unverified.',
    next: "Run yg init and pick 'Configure reviewer' (an installed agent CLI needs no API key), or add reviewer.tiers to .yggdrasil/yg-config.yaml — see yg knowledge read configuration.",
  };
  return [{ code: 'config-reviewer-missing', severity: 'error', rule: 'config-reviewer-missing', ...issueMsg(msgData), messageData: msgData }];
}

// --- aspect-effective-nowhere: a rule source attached where cascade + when match no node ---

/**
 * Dead-attach linter (WARNING). An aspect that ships a rule source (content.md
 * or check.mjs) and is not draft, yet — after the full 7-channel cascade and
 * every `when` predicate — is effective on ZERO nodes: its attach sites plus
 * `when` predicates resolve to nothing, so the reviewer never runs it anywhere.
 * A "dead law that looks enforced". Non-blocking (warning): it flags a graph
 * authoring mistake without failing CI.
 *
 * Reuses the verifier's OWN effectiveness engine (computeEffectiveAspects — the
 * exact per-node function computeExpectedPairs calls) so cascade + `when`
 * semantics are never re-derived here; the "effective node set" is precisely the
 * union of that engine's output over every node.
 *
 * Fires iff ALL hold:
 *   - rule source present: content.md OR check.mjs exists on disk. This silently
 *     excludes aggregating aspects (no own reviewer — their empty-set case is a
 *     no-op the orphan warning covers) and does not pile onto an aspect whose
 *     source is missing (a separate blocking aspect-missing-rule-source error).
 *   - aspect default status ≠ draft — a draft aspect produces no expected pairs
 *     and is intentionally parked; nothing to warn about.
 *   - the aspect id is in NO node's effective-aspect set.
 *
 * Bootstrap carve-out: while the model tree has zero nodes this is COMPLETELY
 * silent — a graph-before-code project legitimately authors aspects before any
 * node exists, and every rule source would otherwise light up at once.
 */
export function checkAspectEffectiveNowhere(graph: Graph): ValidationIssue[] {
  // Bootstrap carve-out: with no nodes, every aspect is trivially effective
  // nowhere. A greenfield graph authoring aspects before any code must stay
  // silent, so short-circuit before computing anything.
  if (graph.nodes.size === 0) return [];

  const projectRoot = path.dirname(graph.rootPath);

  // Union of effective aspect ids across every node (7-channel cascade + when),
  // via the verifier's own engine. A node whose effectiveness throws (an implies
  // cycle — surfaced separately as a blocking aspect-implies-cycle error) is
  // skipped, exactly as computeExpectedPairs skips it.
  const effectiveSomewhere = new Set<string>();
  for (const node of graph.nodes.values()) {
    try {
      for (const id of computeEffectiveAspects(node, graph)) effectiveSomewhere.add(id);
    } catch {
      // ImpliesCycleError or similar structural error — skip this node.
    }
  }

  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    // A draft aspect produces no expected pairs — parked by design, not dead.
    if ((aspect.status ?? 'enforced') === 'draft') continue;

    // Rule-source gate: only aspects that actually ship a reviewer input. This
    // excludes aggregates (no content.md/check.mjs) and aspects mid-edit whose
    // source is absent (a distinct blocking error), so neither double-reports.
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
    const hasRuleSource =
      fileExistsSync(path.join(aspectDir, 'content.md')) ||
      fileExistsSync(path.join(aspectDir, 'check.mjs'));
    if (!hasRuleSource) continue;

    if (effectiveSomewhere.has(aspect.id)) continue;

    const msgData: IssueMessage = {
      what: `Aspect '${aspect.id}' has a rule source but is effective on zero nodes.`,
      why: `Its attach sites plus 'when' predicates match nothing, so the rule is never verified anywhere — dead law that looks enforced.`,
      next: `Check the attach sites and 'when' predicate (yg impact --aspect ${aspect.id}). While authoring graph-before-code this is expected: create the node/type it targets, or set status: draft until the code lands.`,
    };
    issues.push({
      severity: 'warning',
      code: 'aspect-effective-nowhere',
      rule: 'aspect-effective-nowhere',
      ...issueMsg(msgData),
      messageData: msgData,
      nodePath: `aspects/${aspect.id}`,
    });
  }

  return issues;
}

// --- architecture-default-aspect-unreachable: a type default filtered off its own type ---

/**
 * Per-type dead-attach linter (WARNING). The architecture declares aspect A as a
 * DEFAULT for node type T (channel 3), but after the full cascade + every `when`
 * predicate, A is effective on ZERO nodes of type T — its own `when` (or the
 * attach-site `when`) filters it back off the exact type the architecture attaches
 * it to. The rule looks enforced for that type yet silently verifies nothing there.
 * (This is the class behind a rule whose `when: { node: { type: X } }` cancels the
 * architecture's attachment of it to a sibling type Y.)
 *
 * Distinct from aspect-effective-nowhere: A may be effective on OTHER types' nodes
 * (so it is not dead everywhere), yet still unreachable on T specifically.
 *
 * Fires iff ALL hold, per (type T, default-aspect A):
 *   - T has at least one node in the model (no bootstrap noise, and a type with no
 *     instances legitimately has no effective aspects yet).
 *   - A is a declared aspect (an undefined id is a separate aspect-undefined error).
 *   - A is in the effective-aspect set of NO node of type T.
 * Non-blocking (warning): it surfaces a graph-authoring mistake without failing CI.
 */
export function checkArchitectureDefaultAspectUnreachable(graph: Graph): ValidationIssue[] {
  if (graph.nodes.size === 0) return [];

  const definedAspectIds = new Set(graph.aspects.map((a) => a.id));

  // For each type, the set of aspect ids effective on ANY node of that type.
  const effectiveByType = new Map<string, Set<string>>();
  const typeHasNodes = new Set<string>();
  for (const node of graph.nodes.values()) {
    typeHasNodes.add(node.meta.type);
    let set = effectiveByType.get(node.meta.type);
    if (!set) {
      set = new Set<string>();
      effectiveByType.set(node.meta.type, set);
    }
    try {
      for (const id of computeEffectiveAspects(node, graph)) set.add(id);
    } catch {
      // ImpliesCycleError or similar — surfaced separately; skip this node.
    }
  }

  const issues: ValidationIssue[] = [];
  for (const [typeName, typeConfig] of Object.entries(graph.architecture.node_types)) {
    if (!typeHasNodes.has(typeName)) continue; // no instances — nothing to reach.
    const defaults = typeConfig.aspects ?? [];
    const effective = effectiveByType.get(typeName) ?? new Set<string>();
    for (const aspectId of defaults) {
      if (!definedAspectIds.has(aspectId)) continue; // aspect-undefined handles this.
      if (effective.has(aspectId)) continue;
      const msgData: IssueMessage = {
        what: `Aspect '${aspectId}' is a default aspect of type '${typeName}' but is effective on zero nodes of that type.`,
        why: `The architecture attaches it to '${typeName}', but its own 'when' (or the attach-site 'when') filters it back off every '${typeName}' node — so the rule looks enforced for this type yet verifies nothing there.`,
        next: `Widen or remove the aspect's 'when' so it reaches '${typeName}' nodes (yg impact --aspect ${aspectId}), or drop the default from the '${typeName}' type in yg-architecture.yaml if it should not apply there.`,
      };
      issues.push({
        severity: 'warning',
        code: 'architecture-default-aspect-unreachable',
        rule: 'architecture-default-aspect-unreachable',
        ...issueMsg(msgData),
        messageData: msgData,
        nodePath: `aspects/${aspectId}`,
      });
    }
  }
  return issues;
}

// --- aspect-review-overdue: a rule is past its standing review_by date ---

/**
 * Constitution review-cadence linter (WARNING, never blocking). An aspect that
 * declares a `review_by:` date whose day has PASSED (relative to an INJECTED UTC
 * clock) is running unreviewed — the standing request to re-examine whether the
 * rule still earns its place is overdue.
 *
 * Design invariants (spec RZ-18):
 *   - INJECTED CLOCK. `todayUtc` is supplied by the caller; core keeps no
 *     `Date.now`. When the CLI boundary omits the clock, runCheck skips this
 *     check entirely (no fabricated clock, no overdue signal).
 *   - STATUS-INDEPENDENT. draft / advisory / enforced all participate — the
 *     constitution reviews a rule's continued relevance, not its enforcement.
 *   - NEVER writes the lock, changes a verdict, or gates `--approve`. It is a
 *     pure read-only warning; auto-flipping a rule on a clock-dependent, per-CLI
 *     result is rejected forever (nomination-only).
 *
 * Comparison: `today = todayUtc.toISOString().slice(0, 10)` (bare `YYYY-MM-DD`).
 * An aspect is overdue when `aspect.reviewBy < today` — a lexicographic compare,
 * which is correct because both operands are zero-padded ISO bare dates.
 *
 * All overdue aspects share one rule id (`aspect-review-overdue`) with the SAME
 * why+next, so the grouped renderer collapses them into ONE warning block with
 * each affected aspect listed beneath (the same pattern aspect-effective-nowhere
 * uses: the aspect id is carried on a synthetic `aspects/<id>` nodePath, and no
 * `aspectId` is set so grouping is by code only).
 */
export function checkReviewOverdue(graph: Graph, todayUtc: Date): ValidationIssue[] {
  const today = todayUtc.toISOString().slice(0, 10);
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewBy === undefined) continue;   // presence gate
    if (!(aspect.reviewBy < today)) continue;       // due today or in the future → not overdue
    const msgData: IssueMessage = {
      what: `Aspect '${aspect.id}' is past its review_by date (${aspect.reviewBy}).`,
      why: 'A review_by date is a standing request to re-examine whether this rule still earns its place — the date has passed, so the rule is running unreviewed.',
      next: 'Ask the user to renew or retire this rule — propose a new review_by date or a demotion; never change the date without their approval.',
    };
    issues.push({
      severity: 'warning',
      code: 'aspect-review-overdue',
      rule: 'aspect-review-overdue',
      ...issueMsg(msgData),
      messageData: msgData,
      nodePath: `aspects/${aspect.id}`,
    });
  }
  return issues;
}

// --- aspect-tier-unknown: aspect.reviewer.tier must reference a configured tier ---

export function checkAspectTierReferences(graph: Graph): ValidationIssue[] {
  if (graph.configError) return [];
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    const tier = aspect.reviewer.tier;
    if (!tier) continue;
    const tiers = graph.config.reviewer?.tiers ?? {};
    if (!tiers[tier]) {
      const tierNames = Object.keys(tiers);
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' references tier '${tier}' that does not exist in yg-config.yaml.`,
        why: 'Every tier reference must match a configured tier name under reviewer.tiers.',
        next: tierNames.length > 0
          ? `Use one of: ${tierNames.join(', ')}, or remove 'tier:' to use the default tier.`
          : `Add tier '${tier}' under reviewer.tiers in .yggdrasil/yg-config.yaml, or remove 'tier:' from the aspect.`,
      };
      issues.push({ code: 'aspect-tier-unknown', severity: 'error', rule: 'aspect-tier-unknown', ...issueMsg(msgData), messageData: msgData });
    }
  }
  return issues;
}

// --- aspect-errs-invalid: errs is legal only on deterministic aspects ---

/**
 * The `errs` label declares a DETERMINISTIC check's error direction, so it is
 * legal only on deterministic aspects. This is the presence-gated cross-field
 * contract (mirrors checkReviewerPresence's shape): it fires ONLY where the field
 * exists — an absent field is a clean pass, and a valid literal placed on an LLM
 * or aggregating aspect is a blocking error. The literal itself is already
 * validated at parse time (aspect-errs-invalid), so every errs seen here is one of
 * over | under | exact.
 */
export function checkAspectErrsDirection(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.errs === undefined) continue;              // presence gate
    if (aspect.reviewer.type === 'deterministic') continue; // legal placement
    const reviewerNoun = aspect.reviewer.type === 'llm'
      ? 'LLM-reviewed'
      : 'an aggregating aspect with no own check';
    const msgData: IssueMessage = {
      what: `Aspect '${aspect.id}' declares errs: '${aspect.errs}' but reviewer.type is '${aspect.reviewer.type}'.`,
      why: `errs declares a deterministic check's error direction; this aspect is ${reviewerNoun}.`,
      next: 'Set errs to one of over|under|exact, or remove the field — see .yggdrasil/aspects/README.md, section "errs census".',
    };
    issues.push({ code: 'aspect-errs-invalid', severity: 'error', rule: 'aspect-errs-invalid', ...issueMsg(msgData), messageData: msgData });
  }
  return issues;
}

// --- aspect-reference-broken ---

export async function checkAspectReferences(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    if (!aspect.references) continue;
    if (aspect.references.length === 0) {
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' declares 'references: []' (empty list).`,
        why: `empty list has no effect; this is likely a mid-edit state.`,
        next: `either populate the list, or remove the 'references:' line entirely.`,
      };
      issues.push({
        severity: 'warning',
        code: 'aspect-references-empty-array',
        rule: 'aspect-references-empty-array',
        ...issueMsg(msgData),
        messageData: msgData,
      });
      continue;
    }

    for (const ref of aspect.references) {
      const absPath = path.join(projectRoot, ref.path);
      // POSIX-normalize the reference path before embedding it in any output
      // message (the posix-paths-output contract governs these ValidationIssue
      // strings); absPath above is filesystem-only and stays OS-native.
      const refPath = toPosixPath(ref.path);
      let stats: Awaited<ReturnType<typeof statPath>>;
      try {
        stats = await statPath(absPath);
      } catch {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' references '${refPath}' but the file does not exist.`,
          why: `reviewer cannot load missing reference files; fill would fail at runtime.`,
          next: `create the file, fix the path, or remove the reference entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-broken',
          rule: 'aspect-reference-broken',
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }
      if (!stats.isFile()) {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' references '${refPath}' but the path resolves to a directory.`,
          why: `reference files must be regular files; directories cannot be loaded into the reviewer prompt.`,
          next: `point references entry to a specific file or remove the entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-broken',
          rule: 'aspect-reference-broken',
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
    }
  }
  return issues;
}

// --- aspect-status-downgrade: explicit attach-site status must not lower the cascading anchor ---

function sourceIsExplicit(source: AttachSource, node: GraphNode, aspectId: string, graph: Graph): boolean {
  switch (source.channel) {
    case 1: return aspectId in (node.meta.aspectStatus ?? {});
    case 2: {
      const ancestorPath = source.origin.replace(/^ancestor:/, '');
      const ancestor = graph.nodes.get(ancestorPath);
      return aspectId in (ancestor?.meta.aspectStatus ?? {});
    }
    case 3: return aspectId in (graph.architecture?.node_types[node.meta.type]?.aspectStatus ?? {});
    case 4: {
      const m = source.origin.match(/^ancestor-type:[^@]+@(.+)$/);
      const ancestorPath = m?.[1];
      if (!ancestorPath) return false;
      const ancestor = graph.nodes.get(ancestorPath);
      const typeDef = ancestor && graph.architecture?.node_types[ancestor.meta.type];
      return aspectId in (typeDef?.aspectStatus ?? {});
    }
    case 5: {
      const flowPath = source.origin.replace(/^flow:/, '');
      const flow = graph.flows.find(f => f.path === flowPath);
      return aspectId in (flow?.aspectStatus ?? {});
    }
    case 6: {
      const m = source.origin.match(/^port:([^@]+)@(.+)$/);
      if (!m) return false;
      const [, portName, targetPath] = m;
      const target = graph.nodes.get(targetPath);
      const port = target?.meta.ports?.[portName];
      return aspectId in (port?.aspectStatus ?? {});
    }
  }
}

export function checkAspectStatusDowngrade(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes.values()) {
    const statuses = computeEffectiveAspectStatuses(node, graph);
    for (const [aspectId] of statuses) {
      const sources = getAspectStatusSources(node, aspectId, graph);
      const aspectDef = graph.aspects.find(a => a.id === aspectId);
      const aspectDefault: AspectStatus = aspectDef?.status ?? 'enforced';

      for (const source of sources) {
        if (!sourceIsExplicit(source, node, aspectId, graph)) continue;

        // The anchor is what the effective status would be WITHOUT this source's
        // explicit declaration: the max over every OTHER channel's declared
        // status AND the aspect-level default. The default is a permanent member
        // of the anchor — dropping it once a second channel declares would let
        // two channels collude on the same sub-default value (e.g. both advisory
        // under an enforced default) and silently downgrade with no error.
        const otherDeclared = sources.filter(s => s !== source).map(s => s.declared);
        const anchor: AspectStatus = [...otherDeclared, aspectDefault].reduce<AspectStatus>(
          (acc, cur) => (STATUS_ORDER[cur] > STATUS_ORDER[acc] ? cur : acc),
          'draft',
        );

        if (STATUS_ORDER[source.declared] < STATUS_ORDER[anchor]) {
          const msgData = aspectStatusDowngradeMessage({
            nodePath: node.path,
            aspectId,
            declared: source.declared,
            anchor,
            origin: source.origin === `own:${node.path}` ? 'aspect-default and other channels' : source.origin,
          });
          issues.push({
            code: 'aspect-status-downgrade',
            severity: 'error',
            rule: 'aspect-status-downgrade',
            ...issueMsg(msgData),
            messageData: msgData,
            nodePath: node.path,
          });
        }
      }
    }
  }
  return issues;
}

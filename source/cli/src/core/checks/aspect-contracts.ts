import path from 'node:path';
import type { Graph, GraphNode, AspectStatus } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { statPath, fileExistsSync } from '../../io/graph-fs.js';
import { computeEffectiveAspectStatuses, getAspectStatusSources, type AttachSource } from '../graph/aspects.js';
import { aspectStatusDowngradeMessage } from '../../formatters/aspect-status-messages.js';
import { issueMsg } from './shared.js';
import { toPosixPath } from '../../utils/posix.js';
import { computeExpectedPairs } from '../pairs.js';

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

export async function checkReviewerPresence(graph: Graph): Promise<ValidationIssue[]> {
  if (graph.configError) return [];
  if (graph.config.reviewer) return [];
  // A reviewer tier is required only once a judgment (LLM) rule is actually
  // effective. Compute effective, non-draft pairs through the canonical
  // single-source query (draft is excluded by default) and stay silent when no
  // LLM pair exists — a script-only / empty graph is a legal keyless state.
  const { pairs } = await computeExpectedPairs(graph);
  if (!pairs.some((p) => p.kind === 'llm')) return [];
  const msgData: IssueMessage = {
    what: 'A judgment rule has no judge: yg-config.yaml has no reviewer: section.',
    why: 'Script rules run locally for free, but a judgment rule (content.md) needs a configured model to read it — until then its pairs stay unverified.',
    next: "Run yg init and pick 'Configure reviewer' (an installed agent CLI needs no API key), or add reviewer.tiers to .yggdrasil/yg-config.yaml — see yg knowledge read configuration.",
  };
  return [{ code: 'config-reviewer-missing', severity: 'error', rule: 'config-reviewer-missing', ...issueMsg(msgData), messageData: msgData }];
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

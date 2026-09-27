import { Command } from 'commander';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../core/graph/aspects.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
} from '../core/graph/impact-graph.js';
import { handleAspectImpact, handleFlowImpact, handleTypeImpact } from './impact-handlers.js';
import {
  descendantPaths,
  collectInvalidatedPairs,
  computeGraduationPreview,
  computeNodeFillCost,
  summarizeImpact,
} from '../core/impact-cost.js';
import { renderGraduationPreview, renderNodeFillCost, renderImpactTotal } from '../formatters/impact-text.js';
import type { ImpactSummary } from '../model/impact.js';
import { findOwnerWithinOwnGraph } from './owner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { readLock, LockInvalidError } from '../io/lock-store.js';
import type { LockFile } from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';
import { resolveGraphExclusionSet, isExcludedFromGraph, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { IMPACT_JSON_SCHEMA, formatImpactJson } from '../formatters/impact-json.js';
import { buildImpactDocument } from '../core/graph/machine-documents.js';
import { fail, nodeNotFound, note, plural, writeErr, writeOut, failAndExit } from './output.js';

import { DEFAULT_PORT_NAME } from '../model/graph.js';
import type { Graph } from '../model/graph.js';

/** The flags `yg impact` parses. */
interface ImpactOptions {
  node?: string;
  file?: string;
  aspect?: string;
  flow?: string;
  type?: string;
  json?: boolean;
}

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Show reverse dependency impact for a node, aspect, flow, or type')
    .option('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--aspect <id>', 'Aspect id (directory path under aspects/)')
    .option('--flow <name>', 'Flow name (directory name under flows/)')
    .option('--type <id>', 'Architecture type id')
    .option('--json', `Machine-readable output: one ${IMPACT_JSON_SCHEMA} document on stdout instead of the text report. --node and --file only.`)
    .action(
      async (options: ImpactOptions) => {
        try {
          await runImpactCommand(options);
        } catch (error) {
          // A --file path that resolves outside the repository is USER input, not
          // an internal bug — classify it (what/why/next) rather than routing to
          // the generic "file an issue" crash handler. Mirrors owner.ts.
          const msg = error instanceof Error ? error.message : String(error);
          const outsideRoot = msg.match(/^Path is outside project root: (.+)$/);
          if (outsideRoot) {
            debugWrite(`[impact] file arg outside project root: ${msg}`);
            failAndExit({
              what: `The path '${toPosixPath(outsideRoot[1])}' is outside the project root.`,
              why: 'yg impact resolves impact only for files tracked inside the project.',
              next: 'Pass a path inside the project root (relative to the repo).',
            }, 'command-error');
          }
          debugWrite(`[impact] command failed: ${(error as Error).message}`);
          abortOnUnexpectedError(error, 'running impact');
        }
      },
    );
}

/** The command: check the target flags, resolve the target, report its impact. */
async function runImpactCommand(options: ImpactOptions): Promise<void> {
  const asJson = options.json === true;
  refuseInvalidImpactTargets(options, asJson);

  const graph = await loadGraphOrAbort(process.cwd());
  initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
  const lock = await readImpactLock(graph);

  // Set when --file resolves to an owner node, so the shared node-cost
  // render site uses renderImpactTotal instead of renderNodeFillCost.
  let fileImpact: FileImpact | undefined;

  // Resolve --file: compute unified invalidated-pair set, then either
  // exit (no owner) or fall through to the shared node block.
  if (options.file) {
    const resolved = await resolveFileTarget(graph, options.file, lock, asJson);
    if (resolved === null) return;
    fileImpact = resolved.fileImpact;
    options.node = resolved.nodePath;
  }

  if (options.aspect) {
    await handleAspectImpact(graph, options.aspect.trim(), lock, projectRootFromGraph(graph.rootPath));
    return;
  }
  if (options.flow) {
    await handleFlowImpact(graph, options.flow.trim());
    return;
  }
  if (options.type) {
    await handleTypeImpact(graph, options.type.trim(), lock);
    return;
  }

  const nodePath = options.node!.trim().replace(/\/$/, '');

  if (!graph.nodes.has(nodePath)) {
    failAndExit(nodeNotFound(nodePath, "Impact is measured from a node, so the node must exist in the graph."), 'node-not-found');
  }

  if (asJson) {
    // The machine form answers the same question from the same graph
    // queries; it does not pay for the lock-backed cost report the text
    // view ends with, because a cost estimate is not part of the
    // contract a consumer reads.
    writeOut(formatImpactJson(buildImpactDocument(graph, nodePath)));
    await exitAfterFlush(0);
    return;
  }

  await renderNodeImpact(graph, nodePath, lock, fileImpact);
}

/** Refuse a missing, doubled or --json-incompatible target before anything loads. */
function refuseInvalidImpactTargets(options: ImpactOptions, asJson: boolean): void {
  if (options.node && options.file) {
    failAndExit({
          what: '--node and --file are mutually exclusive.',
          why: 'yg impact accepts at most one of these target forms per invocation.',
          next: 'Re-run with only --node <path> OR --file <path>.',
        }, 'usage');
  }

  const modeCount = [options.node || options.file, options.aspect, options.flow, options.type].filter(Boolean).length;
  if (modeCount === 0) {
    failAndExit({
          what: 'No target specified.',
          why: 'yg impact needs exactly one of --node, --file, --aspect, --flow, or --type.',
          next: 'Pass one of: --node <path>, --file <path>, --aspect <id>, --flow <name>, --type <id>.',
        }, 'usage');
  }
  if (modeCount > 1) {
    failAndExit({
          what: 'Multiple targets specified.',
          why: 'yg impact accepts only one of --node/--file, --aspect, --flow, or --type per invocation.',
          next: 'Re-run with a single target form.',
        }, 'command-error');
  }

  if (asJson && (options.aspect || options.flow || options.type)) {
    failAndExit({
          what: `--json is not available for --aspect, --flow, or --type.`,
          why: `A ${IMPACT_JSON_SCHEMA} document describes the blast radius of ONE component — its subject is a component path, and an aspect, a flow, or a type has no such subject. Emitting one for them would mean a second document shape hiding behind the same schema tag.`,
          next: `For a component's blast radius as a document, run yg impact --node <path> --json (or --file <path> --json). For one rule's reach as a document — every unit it judges, with the effective status there — run yg aspects --json --reach; for what the lock says about each of those units, yg check --json, whose pairs join to it on the same unit. Otherwise drop --json for the aspect/flow/type report.`,
        }, 'command-error');
  }
}

/**
 * Load the lock ONCE per command. A garbled/unknown-version lock fails
 * closed with a clear error — impact cannot reason about cross-node
 * file invalidation or refused verdicts without a readable lock.
 */
async function readImpactLock(graph: Graph): Promise<LockFile> {
  try {
    return readLock(graph.rootPath);
  } catch (err) {
    if (err instanceof LockInvalidError) {
      debugWrite(`[impact] readLock failed: ${err.message}`);
      fail(err.messageData, 'lock-invalid');
      await exitAfterFlush(1);
    }
    throw err;
  }
}

/** A --file target's own cost summary, rendered in place of the node's fill cost. */
interface FileImpact {
  summary: ImpactSummary;
  repoRelative: string;
}

/**
 * Resolve a --file target. Answers — and ends the command — for a graph file,
 * an excluded path, a file nothing covers, and a file no component owns;
 * otherwise returns the owning node to report on (and, for the text view, the
 * file's own cost summary). Null when the command has already answered.
 */
async function resolveFileTarget(
  graph: Graph,
  file: string,
  lock: LockFile,
  asJson: boolean,
): Promise<{ nodePath: string; fileImpact: FileImpact | undefined } | null> {
  const repoRoot = projectRootFromGraph(graph.rootPath);
  const repoRelative = resolveFileArg(repoRoot, file);

  const redirect = await fileRedirect(graph, repoRoot, repoRelative);
  if (redirect !== null) {
    // Under --json stdout carries the document ALONE, so a redirect
    // that produces no document is a diagnostic and belongs on
    // stderr. The exit code is the text view's, unchanged.
    if (asJson) writeErr(redirect);
    else writeOut(redirect);
    await exitAfterFlush(0);
    return null;
  }

  const ownerResult = await findOwnerWithinOwnGraph(graph, repoRoot, repoRelative);
  // The invalidated-pair set is what the per-pair COST report is built
  // from, and it enumerates every expected pair in the project. A
  // --json run that already has an owner never renders that report, so
  // it does not pay for the enumeration; with no owner it still does,
  // because distinguishing "no coverage at all" (exit 1) from a
  // file some rule reaches without owning it is exactly what the set
  // answers, and --json keeps the text view's exit codes.
  const set =
    asJson && ownerResult.nodePath
      ? undefined
      : await collectInvalidatedPairs(graph, repoRelative, lock, repoRoot);

  if (!ownerResult.nodePath) {
    // `set` is always present here: the only run that skips the
    // enumeration is a --json run WITH an owner.
    await renderOwnerlessFile(graph, repoRelative, lock, set!, asJson);
    return null;
  }

  // Structural owner found — capture for the cost-render site,
  // print the owner resolution line, then fall through to the shared
  // node block for relationship detail.
  const fileImpact = set ? { summary: summarizeImpact(set, graph, lock), repoRelative } : undefined;
  // Under --json the owner resolution is already carried by the
  // document's own subject, and stdout must hold the document alone.
  if (!asJson) writeOut(`${ownerResult.file} -> ${ownerResult.nodePath}\n`);
  return { nodePath: ownerResult.nodePath, fileImpact };
}

/**
 * The answer for a --file path whose edit is not a per-pair subject edit at all
 * — a graph file, or a path excluded from the graph — or null for any other.
 */
async function fileRedirect(graph: Graph, repoRoot: string, repoRelative: string): Promise<string | null> {
  // Graph-file redirect — graph files are not subject-file edits.
  if (repoRelative.startsWith('.yggdrasil/')) {
    return buildIssueMessage({
      what: `${repoRelative} is a graph file — its cost is not a per-pair subject edit.`,
      why: 'The per-pair cost model tracks subject-file edits; rule and companion hash changes are not modeled as per-pair subjects.',
      next: 'To estimate the cost of editing an aspect rule or companion, run yg impact --aspect <id>.',
    }) + '\n';
  }

  // Exclusion redirect — answered BEFORE ownership or the invalidated-
  // pair set are even computed. An excluded path (a nested project's
  // own boundary, or a coverage.excluded root) is invisible to every
  // enforcement surface this graph has: no pair ever admits it as a
  // subject, and no aspect can actually read it (structure/ctx-fs.ts's
  // resolveAllowedReadPath refuses the read at runtime), so editing it
  // can never invalidate a verdict. Deciding this first — rather than
  // falling through to collectInvalidatedPairs and trusting whatever it
  // reports — means the answer stays true even where that set's own
  // "cold-start" estimate (an allowed-reads text match with no runtime
  // confirmation) would otherwise admit a pair nothing can really touch.
  const exclusion = await resolveGraphExclusionSet(repoRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  if (isExcludedFromGraph(repoRelative, exclusion)) {
    return buildIssueMessage({
      what: `${repoRelative} is excluded from graph coverage by design.`,
      why: 'This path sits inside a separate project\'s own boundary, or matches a coverage.excluded root — no node enforces it and no aspect can read it, so editing it invalidates nothing.',
      next: 'No action needed.',
    }) + '\n';
  }
  return null;
}

/** The answer for a --file path no component owns, and its exit code. */
async function renderOwnerlessFile(
  graph: Graph,
  repoRelative: string,
  lock: LockFile,
  set: Awaited<ReturnType<typeof collectInvalidatedPairs>>,
  asJson: boolean,
): Promise<void> {
  // No coverage at all — not mapped, not referenced, not observed.
  if (set.pairs.length === 0 && set.unresolved.length === 0) {
    fail({
      what: `${repoRelative} -> no graph coverage`,
      why: 'file is not mapped to any node, is not referenced by any aspect, and is not observed by any script rule or companion-backed reviewer rule in the graph.',
      next: 'Add the file to an existing node mapping, or create a new node.',
    }, 'command-error');
    await exitAfterFlush(1);
    return;
  }

  if (asJson) {
    // No component owns the file, so there is no subject a
    // yg-impact/1 document could name — that document's subject is a
    // component, always. Say so, and keep the text view's exit code.
    writeErr(
      buildIssueMessage({
        what: `No component owns ${repoRelative}.`,
        why: `A ${IMPACT_JSON_SCHEMA} document describes the blast radius of one COMPONENT, so a file with no owning component has no subject to report on. Its rules, if its architecture type governs it, are still real.`,
        next: `Run yg impact --file ${repoRelative} without --json for the per-pair cost view, or yg context --file ${repoRelative} --json for what governs it.`,
      }) + '\n',
    );
    await exitAfterFlush(0);
    return;
  }

  // No structural owner. When the file is ITSELF enforced by its
  // architecture type alone (type-covered, not merely referenced
  // or observed by some other pair), also preview what giving it
  // a component of its own would cost — reusing this SAME
  // invocation's pair universe (set.allPairs / set.typeCoverage)
  // rather than paying a second, full computeExpectedPairs
  // enumeration just to answer this one extra question.
  const summary = summarizeImpact(set, graph, lock);
  if (set.typeCoverage?.covered.has(repoRelative)) {
    const preview = await computeGraduationPreview(graph, repoRelative, set.typeCoverage, set.allPairs);
    writeOut(renderGraduationPreview(preview));
  }
  // Render the Total and exit. This is an ADD over the old
  // behavior which early-exited with no cost.
  writeOut(renderImpactTotal(summary, repoRelative));
  await exitAfterFlush(0);
}

/** One event-connected node: an emitter or listener on the target's events. */
interface EventDependent {
  path: string;
  type: string;
  eventName: string;
}

/**
 * The event-based dependents (emits/listens) of a node: every node relating to
 * it by an event, and every listener on an event the node itself emits.
 */
function collectEventDependents(graph: Graph, nodePath: string): EventDependent[] {
  const eventDependents: EventDependent[] = [];
  for (const [np, n] of graph.nodes) {
    for (const rel of n.meta.relations ?? []) {
      if (rel.target === nodePath && (rel.type === 'emits' || rel.type === 'listens')) {
        eventDependents.push({
          path: np,
          type: rel.type,
          eventName: rel.event_name ?? n.meta.name,
        });
      }
    }
  }
  // Also check if the target node emits events and find listeners
  const targetNode = graph.nodes.get(nodePath)!;
  for (const rel of targetNode.meta.relations ?? []) {
    if (rel.type === 'emits') {
      const eventName = rel.event_name ?? rel.target;
      // Find listeners for this event target
      for (const [np, n] of graph.nodes) {
        if (np === nodePath) continue;
        for (const r of n.meta.relations ?? []) {
          if (r.type === 'listens' && r.target === rel.target) {
            eventDependents.push({
              path: np,
              type: 'listens',
              eventName: r.event_name ?? eventName,
            });
          }
        }
      }
    }
  }
  return eventDependents;
}

/** The text report of a node's impact: dependents, hierarchy, flows, aspects, cost. */
async function renderNodeImpact(graph: Graph, nodePath: string, lock: LockFile, fileImpact: FileImpact | undefined): Promise<void> {
  const { direct, allDependents, reverse, relationFrom } = collectReverseDependents(
    graph,
    nodePath,
  );

  const chains = buildTransitiveChains(nodePath, direct, allDependents, reverse);
  const eventDependents = collectEventDependents(graph, nodePath);

  const flows: string[] = [];
  for (const flow of graph.flows) {
    if (flow.nodes.includes(nodePath)) {
      flows.push(flow.name);
    }
  }

  const targetNodeForAspects = graph.nodes.get(nodePath)!;
  const targetEffective = computeEffectiveAspects(targetNodeForAspects, graph);
  const targetStatuses = computeEffectiveAspectStatuses(targetNodeForAspects, graph);
  const aspectsInScope: string[] = [];
  for (const aspect of graph.aspects) {
    if (targetEffective.has(aspect.id)) {
      const status = targetStatuses.get(aspect.id) ?? aspect.status ?? 'enforced';
      aspectsInScope.push(`${aspect.name} [${status}]`);
    }
  }

  writeOut(`Impact of changes in ${nodePath}:\n\n`);
  renderDependents(nodePath, direct, relationFrom, eventDependents, chains);

  const descendants = descendantPaths(graph, nodePath);
  if (descendants.length > 0) {
    writeOut('\nDescendants (hierarchy impact):\n');
    for (const desc of descendants) {
      writeOut(`  ${desc}\n`);
    }
  }

  // Collect indirect dependents of descendants
  const alreadyShown = new Set([nodePath, ...allDependents, ...descendants, ...eventDependents.map((e) => e.path)]);
  const descIndirectPaths = renderIndirectDependents(graph, descendants, alreadyShown);

  writeOut(
    `\nFlows: ${flows.length > 0 ? flows.join(', ') : '(none)'}\n`,
  );
  writeOut(
    `Aspects: ${aspectsInScope.length > 0 ? aspectsInScope.join(', ') : '(none)'}\n`,
  );

  renderSharedAspectNodes(graph, nodePath, targetEffective);

  const allAffected = new Set([...allDependents, ...descendants, ...eventDependents.map((e) => e.path), ...descIndirectPaths]);
  writeOut(
    `\nBlast radius: ${allAffected.size} ${plural(allAffected.size, 'node')}, ${flows.length} ${plural(flows.length, 'flow')}, ${aspectsInScope.length} ${plural(aspectsInScope.length, 'aspect')}\n`,
  );
  if (fileImpact) {
    writeOut(renderImpactTotal(fileImpact.summary, fileImpact.repoRelative));
  } else {
    writeOut(renderNodeFillCost(await computeNodeFillCost(graph, nodePath, lock), 'node'));
  }
  if (allAffected.size >= 10) {
    writeOut(`${note('high blast radius — read the direct dependents above before changing this node')}\n`);
  } else if (allAffected.size > 0) {
    writeOut(`${note('read the direct dependents above before changing this node')}\n`);
  }
  writeOut(
    '\n' + buildIssueMessage({
      what: `You are about to change node ${toPosixPath(nodePath)}.`,
      why: 'Dependents listed above may be affected by changes to this node.',
      next: `yg context --node ${toPosixPath(nodePath)}  (for any dependent you are unsure about)`,
    }) + '\n',
  );
}

/** The direct, event-connected and transitive dependents sections. */
function renderDependents(
  nodePath: string,
  direct: string[],
  relationFrom: ReturnType<typeof collectReverseDependents>['relationFrom'],
  eventDependents: EventDependent[],
  chains: string[],
): void {
  writeOut('Directly dependent:\n');
  if (direct.length === 0) {
    writeOut('  (none)\n');
  } else {
    for (const dep of direct) {
      const rel = relationFrom.get(`${dep}->${nodePath}`);
      // 'default' is never absent any more (an undeclared relation
      // normalizes to it) — only a port named BEYOND the implicit one
      // is worth annotating.
      const namedPorts = rel?.consumes.filter((p) => p !== DEFAULT_PORT_NAME) ?? [];
      const annot = namedPorts.length > 0
        ? ` (${rel!.type}, consumes: ${namedPorts.join(', ')})`
        : rel
          ? ` (${rel.type})`
          : '';
      writeOut(`  <- ${dep}${annot}\n`);
    }
  }

  if (eventDependents.length > 0) {
    writeOut('\nEvent-connected:\n');
    for (const { path: p, type, eventName } of eventDependents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      writeOut(`  ${p} (${type}: ${eventName})\n`);
    }
  }
  writeOut('\nTransitively dependent:\n');
  if (chains.length === 0) {
    writeOut('  (none)\n');
  } else {
    for (const chain of chains) {
      writeOut(`  ${chain}\n`);
    }
  }
}

/**
 * The structural dependents of the node's descendants not already shown, as
 * their own section; returns their paths for the blast-radius count.
 */
function renderIndirectDependents(graph: Graph, descendants: string[], alreadyShown: Set<string>): string[] {
  if (descendants.length === 0) return [];
  const { indirectPaths: rawIndirect, chains: rawChains } = collectIndirectDependents(graph, descendants);
  const filteredIndirect: string[] = [];
  const filteredChains: string[] = [];
  for (let i = 0; i < rawIndirect.length; i++) {
    if (!alreadyShown.has(rawIndirect[i])) {
      filteredIndirect.push(rawIndirect[i]);
      filteredChains.push(rawChains[i]);
    }
  }
  if (filteredChains.length > 0) {
    writeOut('\nIndirectly affected (structural dependents of descendants):\n');
    for (const chain of filteredChains) {
      writeOut(`  ${chain}\n`);
    }
  }
  return filteredIndirect;
}

/**
 * The "Nodes sharing aspects" section. A "ubiquitous" aspect (effective on many
 * nodes — a posix/style check attached to most of the graph) is a
 * co-occurrence, not a real dependency: every node "shares" it, so it adds no
 * signal and only buries the actionable blast-radius footer. Count effective
 * nodes per target aspect once, then omit any aspect over the threshold from
 * the section (with a one-line note).
 */
function renderSharedAspectNodes(graph: Graph, nodePath: string, targetEffective: Set<string>): void {
  const UBIQUITOUS_THRESHOLD = 20;
  const aspectEffectiveCount = new Map<string, number>();
  for (const [p] of graph.nodes) {
    const eff = computeEffectiveAspects(graph.nodes.get(p)!, graph);
    for (const id of targetEffective) {
      if (eff.has(id)) aspectEffectiveCount.set(id, (aspectEffectiveCount.get(id) ?? 0) + 1);
    }
  }
  const ubiquitousAspects = [...targetEffective].filter(
    (id) => (aspectEffectiveCount.get(id) ?? 0) > UBIQUITOUS_THRESHOLD,
  );
  const ubiquitousSet = new Set(ubiquitousAspects);

  const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
  if (targetEffective.size > 0) {
    for (const [p] of graph.nodes) {
      if (p === nodePath) continue;
      const otherNode = graph.nodes.get(p)!;
      const nodeEffective = computeEffectiveAspects(otherNode, graph);
      const otherStatuses = computeEffectiveAspectStatuses(otherNode, graph);
      const shared = [...targetEffective]
        .filter((id) => nodeEffective.has(id) && !ubiquitousSet.has(id))
        .map((id) => {
          const aspectDef = graph.aspects.find(a => a.id === id);
          const status = otherStatuses.get(id) ?? aspectDef?.status ?? 'enforced';
          return `${id} [${status}]`;
        });
      if (shared.length > 0) {
        coAspectNodes.push({ path: p, shared });
      }
    }
  }
  if (coAspectNodes.length > 0) {
    writeOut('Nodes sharing aspects:\n');
    for (const { path: p, shared } of coAspectNodes.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      writeOut(`  ${p} (${shared.join(', ')})\n`);
    }
  }
  if (ubiquitousAspects.length > 0) {
    writeOut(
      `  (${ubiquitousAspects.length} ubiquitous aspect${ubiquitousAspects.length === 1 ? '' : 's'} omitted — they don't indicate a real dependency)\n`,
    );
  }
}

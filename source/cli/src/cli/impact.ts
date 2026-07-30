import { Command } from 'commander';
import chalk from 'chalk';
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
import {
  collectDescendants,
  collectInvalidatedPairs,
  computeNodeFillCost,
  handleAspectImpact,
  handleFlowImpact,
  handleTypeImpact,
  renderNodeFillCost,
  summarizeImpact,
  renderImpactTotal,
} from './impact-handlers.js';
import type { ImpactSummary } from './impact-handlers.js';
import { findOwner } from './owner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { readLock, LockInvalidError } from '../io/lock-store.js';
import type { LockFile } from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Show reverse dependency impact for a node, aspect, flow, or type')
    .option('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--aspect <id>', 'Aspect id (directory path under aspects/)')
    .option('--flow <name>', 'Flow name (directory name under flows/)')
    .option('--type <id>', 'Architecture type id')
    .action(
      async (options: { node?: string; file?: string; aspect?: string; flow?: string; type?: string }) => {
        try {
          if (options.node && options.file) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '--node and --file are mutually exclusive.',
                  why: 'yg impact accepts at most one of these target forms per invocation.',
                  next: 'Re-run with only --node <path> OR --file <path>.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const modeCount = [options.node || options.file, options.aspect, options.flow, options.type].filter(Boolean).length;
          if (modeCount === 0) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'No target specified.',
                  why: 'yg impact needs exactly one of --node, --file, --aspect, --flow, or --type.',
                  next: 'Pass one of: --node <path>, --file <path>, --aspect <id>, --flow <name>, --type <id>.',
                })}\n`,
              ),
            );
            process.exit(1);
          }
          if (modeCount > 1) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'Multiple targets specified.',
                  why: 'yg impact accepts only one of --node/--file, --aspect, --flow, or --type per invocation.',
                  next: 'Re-run with a single target form.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const graph = await loadGraphOrAbort(process.cwd());
          initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

          // Load the lock ONCE per command. A garbled/unknown-version lock fails
          // closed with a clear error — impact cannot reason about cross-node
          // file invalidation or refused verdicts without a readable lock.
          let lock: LockFile;
          try {
            lock = readLock(graph.rootPath);
          } catch (err) {
            if (err instanceof LockInvalidError) {
              debugWrite(`[impact] readLock failed: ${err.message}`);
              process.stderr.write(chalk.red(`Error: ${buildIssueMessage(err.messageData)}\n`));
              await exitAfterFlush(1);
            }
            throw err;
          }

          // Set when --file resolves to an owner node, so the shared node-cost
          // render site uses renderImpactTotal instead of renderNodeFillCost.
          let fileImpact: { summary: ImpactSummary; repoRelative: string } | undefined;

          // Resolve --file: compute unified invalidated-pair set, then either
          // exit (no owner) or fall through to the shared node block.
          if (options.file) {
            const repoRoot = projectRootFromGraph(graph.rootPath);
            const repoRelative = resolveFileArg(repoRoot, options.file);

            // Graph-file redirect — graph files are not subject-file edits.
            if (repoRelative.startsWith('.yggdrasil/')) {
              process.stdout.write(
                buildIssueMessage({
                  what: `${repoRelative} is a graph file — its cost is not a per-pair subject edit.`,
                  why: 'The per-pair cost model tracks subject-file edits; rule and companion hash changes are not modeled as per-pair subjects.',
                  next: 'To estimate the cost of editing an aspect rule or companion, run yg impact --aspect <id>.',
                }) + '\n',
              );
              await exitAfterFlush(0);
              return;
            }

            const ownerResult = findOwner(graph, repoRoot, repoRelative);
            const set = await collectInvalidatedPairs(graph, repoRelative, lock, repoRoot);

            // No coverage at all — not mapped, not referenced, not observed.
            if (!ownerResult.nodePath && set.pairs.length === 0 && set.unresolved.length === 0) {
              process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
                what: `${repoRelative} -> no graph coverage`,
                why: 'file is not mapped to any node, is not referenced by any aspect, and is not observed by any deterministic or companion-backed aspect in the graph.',
                next: 'Add the file to an existing node mapping, or create a new node.',
              })}\n`));
              await exitAfterFlush(1);
              return;
            }

            const summary = summarizeImpact(set, graph, lock);

            if (!ownerResult.nodePath) {
              // No structural owner — render the Total and exit. This is an
              // ADD over the old behavior which early-exited with no cost.
              process.stdout.write(renderImpactTotal(summary, repoRelative, { isTTY: process.stdout.isTTY ?? false }));
              await exitAfterFlush(0);
              return;
            }

            // Structural owner found — capture for the cost-render site below,
            // print the owner resolution line, then fall through to the shared
            // node block for relationship detail.
            fileImpact = { summary, repoRelative };
            process.stdout.write(`${ownerResult.file} -> ${ownerResult.nodePath}\n`);
            options.node = ownerResult.nodePath;
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
            await handleTypeImpact(graph, options.type.trim());
            return;
          }

          const nodePath = options.node!.trim().replace(/\/$/, '');

          if (!graph.nodes.has(nodePath)) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Node not found: ${nodePath}`,
              why: 'The node path must match a node in the graph.',
              next: 'Run: yg tree — to list all nodes.',
            })}\n`));
            process.exit(1);
          }

          const { direct, allDependents, reverse, relationFrom } = collectReverseDependents(
            graph,
            nodePath,
          );

          const chains = buildTransitiveChains(nodePath, direct, allDependents, reverse);

          // Collect event-based dependents (emits/listens)
          const eventDependents: Array<{ path: string; type: string; eventName: string }> = [];
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

          process.stdout.write(`Impact of changes in ${nodePath}:\n\n`);
          process.stdout.write('Directly dependent:\n');
          if (direct.length === 0) {
            process.stdout.write('  (none)\n');
          } else {
            for (const dep of direct) {
              const rel = relationFrom.get(`${dep}->${nodePath}`);
              const annot = rel?.consumes?.length
                ? ` (${rel.type}, consumes: ${rel.consumes.join(', ')})`
                : rel
                  ? ` (${rel.type})`
                  : '';
              process.stdout.write(`  <- ${dep}${annot}\n`);
            }
          }

          if (eventDependents.length > 0) {
            process.stdout.write('\nEvent-connected:\n');
            for (const { path: p, type, eventName } of eventDependents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
              process.stdout.write(`  ${p} (${type}: ${eventName})\n`);
            }
          }
          process.stdout.write('\nTransitively dependent:\n');
          if (chains.length === 0) {
            process.stdout.write('  (none)\n');
          } else {
            for (const chain of chains) {
              process.stdout.write(`  ${chain}\n`);
            }
          }

          const descendants = collectDescendants(graph, nodePath);
          if (descendants.length > 0) {
            process.stdout.write('\nDescendants (hierarchy impact):\n');
            for (const desc of descendants) {
              process.stdout.write(`  ${desc}\n`);
            }
          }

          // Collect indirect dependents of descendants
          const alreadyShown = new Set([nodePath, ...allDependents, ...descendants, ...eventDependents.map((e) => e.path)]);
          let descIndirectPaths: string[] = [];
          if (descendants.length > 0) {
            const { indirectPaths: rawIndirect, chains: rawChains } = collectIndirectDependents(graph, descendants);
            const filteredIndirect: string[] = [];
            const filteredChains: string[] = [];
            for (let i = 0; i < rawIndirect.length; i++) {
              if (!alreadyShown.has(rawIndirect[i])) {
                filteredIndirect.push(rawIndirect[i]);
                filteredChains.push(rawChains[i]);
              }
            }
            descIndirectPaths = filteredIndirect;
            if (filteredChains.length > 0) {
              process.stdout.write('\nIndirectly affected (structural dependents of descendants):\n');
              for (const chain of filteredChains) {
                process.stdout.write(`  ${chain}\n`);
              }
            }
          }

          process.stdout.write(
            `\nFlows: ${flows.length > 0 ? flows.join(', ') : '(none)'}\n`,
          );
          process.stdout.write(
            `Aspects: ${aspectsInScope.length > 0 ? aspectsInScope.join(', ') : '(none)'}\n`,
          );

          // A "ubiquitous" aspect (effective on many nodes — a posix/style check
          // attached to most of the graph) is a co-occurrence, not a real
          // dependency: every node "shares" it, so it adds no signal and only
          // buries the actionable blast-radius footer. Count effective nodes per
          // target aspect once, then omit any aspect over the threshold from the
          // "Nodes sharing aspects" section (with a one-line note).
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
            process.stdout.write('Nodes sharing aspects:\n');
            for (const { path: p, shared } of coAspectNodes.sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            )) {
              process.stdout.write(`  ${p} (${shared.join(', ')})\n`);
            }
          }
          if (ubiquitousAspects.length > 0) {
            process.stdout.write(
              `  (${ubiquitousAspects.length} ubiquitous aspect${ubiquitousAspects.length === 1 ? '' : 's'} omitted — they don't indicate a real dependency)\n`,
            );
          }

          const allAffected = new Set([...allDependents, ...descendants, ...eventDependents.map((e) => e.path), ...descIndirectPaths]);
          process.stdout.write(
            `\nBlast radius: ${allAffected.size} nodes, ${flows.length} flows, ${aspectsInScope.length} aspects\n`,
          );
          if (fileImpact) {
            process.stdout.write(renderImpactTotal(fileImpact.summary, fileImpact.repoRelative, { isTTY: process.stdout.isTTY ?? false }));
          } else {
            process.stdout.write(renderNodeFillCost(await computeNodeFillCost(graph, nodePath, lock), 'node'));
          }
          if (allAffected.size >= 10) {
            process.stdout.write(`  High blast radius — review direct dependents before changing this node.\n`);
          } else if (allAffected.size > 0) {
            process.stdout.write(`  Review direct dependents before changing this node.\n`);
          }
          process.stdout.write(
            '\n' + buildIssueMessage({
              what: `You are about to change node ${toPosixPath(nodePath)}.`,
              why: 'Dependents listed above may be affected by changes to this node.',
              next: `Run yg context --node ${toPosixPath(nodePath)} for any dependent you are unsure about.`,
            }) + '\n',
          );
        } catch (error) {
          // A --file path that resolves outside the repository is USER input, not
          // an internal bug — classify it (what/why/next) rather than routing to
          // the generic "file an issue" crash handler. Mirrors owner.ts.
          const msg = error instanceof Error ? error.message : String(error);
          const outsideRoot = msg.match(/^Path is outside project root: (.+)$/);
          if (outsideRoot) {
            debugWrite(`[impact] file arg outside project root: ${msg}`);
            process.stderr.write(chalk.red('Error: ' + buildIssueMessage({
              what: `The path '${toPosixPath(outsideRoot[1])}' is outside the project root.`,
              why: 'yg impact resolves impact only for files tracked inside the project.',
              next: 'Pass a path inside the project root (relative to the repo).',
            }) + '\n'));
            process.exit(1);
          }
          debugWrite(`[impact] command failed: ${(error as Error).message}`);
          abortOnUnexpectedError(error, 'running impact');
        }
      },
    );
}

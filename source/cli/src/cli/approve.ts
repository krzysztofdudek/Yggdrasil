import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { approveNode } from '../core/approve.js';
import { classifyDrift } from '../core/check.js';
import type { CheckIssue, CascadeCause } from '../core/check.js';
import { createLlmProvider } from '../llm/provider.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import type { LlmProvider } from '../llm/types.js';
import type { ApproveResult } from '../model/drift.js';
import type { Graph } from '../model/graph.js';

// Track cloud provider notice per process session
let sessionNoticeShown = false;

// ── Output formatting ────────────────────────────────────────

function shortHash(h: string): string {
  return h.slice(0, 8);
}

export function formatResult(nodePath: string, result: ApproveResult): void {
  const prev = result.previousHash ? shortHash(result.previousHash) : '(none)';
  const curr = result.currentHash ? shortHash(result.currentHash) : '(none)';

  switch (result.action) {
    case 'approved':
      process.stdout.write(chalk.green(`Approved: ${nodePath}\n`));
      process.stdout.write(`  Hash: ${prev} -> ${curr}\n`);
      if (result.aspectResults || result.artifactReviewResults) {
        const aspectCount = result.aspectResults
          ? Object.keys(result.aspectResults).length
          : 0;
        const artifactCount = result.artifactReviewResults
          ? Object.keys(result.artifactReviewResults).length
          : 0;
        process.stdout.write(`  Verified: ${aspectCount} aspects satisfied, ${artifactCount} artifacts current.\n`);
      }
      break;

    case 'reviewed': {
      const isBlackboxCascade =
        result.isBlackbox && !result.blackboxBlocked && result.changedOther?.length;
      if (isBlackboxCascade) {
        process.stdout.write(chalk.green(`Reviewed: ${nodePath} (blackbox, cascade)\n`));
        process.stdout.write(`  Hash: ${prev} -> ${curr}\n`);
        process.stdout.write(
          `  Note: upstream context changed, source not modified. Blackbox intact.\n`,
        );
      } else {
        process.stdout.write(chalk.green(`Reviewed: ${nodePath}\n`));
        process.stdout.write(`  Hash: ${prev} -> ${curr}\n`);
        process.stdout.write(
          result.llmSkipped
            ? `  Three-axis gate bypassed — reviewer not run (${result.llmSkipped}).\n`
            : `  Three-axis gate bypassed — reviewer verified aspects.\n`,
        );
      }
      break;
    }

    case 'initial':
      process.stdout.write(chalk.green(`Approved: ${nodePath} (initial)\n`));
      process.stdout.write(`  Hash: (none) -> ${curr}\n`);
      break;

    case 'no-change':
      process.stdout.write(`No changes: ${nodePath}\n`);
      process.stdout.write(`  Hash: ${curr} — baseline already current. No approval needed.\n`);
      break;

    case 'refused':
      formatRefused(nodePath, result);
      break;
  }

  formatLlmResults(result);

  // Report GC'd orphaned drift state
  if (result.gcPaths && result.gcPaths.length > 0) {
    for (const p of result.gcPaths) {
      process.stdout.write(chalk.dim(`Removed orphaned drift state: ${p}\n`));
    }
  }
}

function formatLlmResults(result: ApproveResult): void {
  if (result.llmSkipped) {
    const messages: Record<NonNullable<ApproveResult['llmSkipped']>, string> = {
      'not-configured': 'Reviewer not configured — aspects not verified. Structural checks only.\n  To enable: add reviewer section to yg-config.yaml.',
      'unavailable': 'Reviewer configured but not reachable — aspects not verified. Structural checks only.',
      'blackbox': 'Reviewer skipped for blackbox node.',
    };
    process.stdout.write(chalk.dim(`  ${messages[result.llmSkipped]}\n`));
    return;
  }

  if (result.aspectResults) {
    process.stdout.write('\nAspect verification:\n');
    for (const [aspectId, aspectResult] of Object.entries(result.aspectResults)) {
      if (aspectResult.satisfied) {
        process.stdout.write(chalk.green(`  ${aspectId} — SATISFIED\n`));
      } else {
        process.stdout.write(chalk.red(`  ${aspectId} — NOT SATISFIED\n`));
        process.stdout.write(`    ${aspectResult.reason}\n`);
      }
    }
  }

  if (result.artifactReviewResults) {
    process.stdout.write('\nArtifact review:\n');
    for (const [name, review] of Object.entries(result.artifactReviewResults)) {
      if (review.current) {
        process.stdout.write(`  ${name} — ${chalk.green('current')}\n`);
      } else {
        process.stdout.write(`  ${name} — ${chalk.red('STALE')}\n`);
        process.stdout.write(`    ${review.reason}\n`);
      }
    }
  }
}

function formatRefused(nodePath: string, result: ApproveResult): void {
  // Anti-laundering
  if (result.antiLaunderingBlocked) {
    process.stderr.write(
      chalk.red(
        'ERROR: Anti-laundering — cannot create blackbox over previously tracked files.\n',
      ),
    );
    if (result.conflictingFiles && result.conflictingFiles.length > 0) {
      process.stderr.write('  Conflicting files:\n');
      for (const cf of result.conflictingFiles) {
        process.stderr.write(`    ${cf.file} (tracked by ${cf.trackedBy})\n`);
      }
    } else {
      process.stderr.write(
        '  Some mapped files appear in drift state of other nodes.\n',
      );
    }
    process.stderr.write(
      '  Decompose: create a proper node (not blackbox) for these files.\n',
    );
    return;
  }

  // Blackbox source change
  if (result.blackboxBlocked) {
    if (result.reviewedAttempted) {
      process.stderr.write(
        chalk.red(`ERROR: Cannot use --reviewed for source changes on a blackbox node.\n`),
      );
      process.stderr.write(
        `  --reviewed does not apply to blackbox source changes.\n`,
      );
      process.stderr.write(
        `  Decompose the blackbox: create a proper node for modified files.\n`,
      );
    } else {
      process.stderr.write(
        chalk.red(`ERROR: Cannot approve source changes on a blackbox node.\n`),
      );
      if (result.changedSource && result.changedSource.length > 0) {
        process.stderr.write(`  Source changed:\n`);
        for (const f of result.changedSource) {
          process.stderr.write(`    ${f}\n`);
        }
      }
      process.stderr.write(
        `  Blackbox nodes are sealed — source modifications require decomposition.\n`,
      );
      process.stderr.write(`  To resolve:\n`);
      process.stderr.write(
        `    1. Create a proper node for the modified files.\n`,
      );
      process.stderr.write(
        `    2. Adjust blackbox mapping to exclude those files.\n`,
      );
      process.stderr.write(
        `    3. Approve the new proper node instead.\n`,
      );
    }
    return;
  }

  const axes = result.axes;
  if (!axes) return;

  // Row 3: source changed, artifacts unchanged
  if (axes.source === 'changed' && axes.ownArtifacts === 'unchanged') {
    process.stderr.write(
      chalk.red(`ERROR: Source changed but graph artifacts unchanged.\n`),
    );
    if (result.changedSource && result.changedSource.length > 0) {
      process.stderr.write(`  Source changed:\n`);
      for (const f of result.changedSource) {
        process.stderr.write(`    ${f}\n`);
      }
    }
    if (result.unchangedArtifactNames && result.unchangedArtifactNames.length > 0) {
      process.stderr.write(`  Artifacts unchanged:\n`);
      process.stderr.write(`    ${result.unchangedArtifactNames.join(', ')}\n`);
    }
    process.stderr.write(
      `  Update artifacts to reflect source changes, then approve.\n`,
    );
    process.stderr.write(
      `  If change has no graph impact (formatting, comments): approve --reviewed "reason".\n`,
    );
    return;
  }

  // Row 2: artifacts changed, source unchanged
  if (axes.ownArtifacts === 'changed' && axes.source === 'unchanged') {
    process.stderr.write(
      chalk.red(`ERROR: Graph artifacts changed but source unchanged.\n`),
    );
    if (result.changedOwnArtifacts && result.changedOwnArtifacts.length > 0) {
      process.stderr.write(`  Artifacts changed:\n`);
      for (const f of result.changedOwnArtifacts) {
        process.stderr.write(`    ${f}\n`);
      }
    }
    if (result.unchangedSourceFiles && result.unchangedSourceFiles.length > 0) {
      process.stderr.write(`  Source unchanged:\n`);
      for (const f of result.unchangedSourceFiles) {
        process.stderr.write(`    ${f}\n`);
      }
    }
    process.stderr.write(
      `  Implement the artifact changes in source, then approve.\n`,
    );
    process.stderr.write(
      `  If change has no source impact (typo, clarification): approve --reviewed "reason".\n`,
    );
    return;
  }

  // Row 4: cascade only
  if (
    axes.ownArtifacts === 'unchanged' &&
    axes.source === 'unchanged' &&
    axes.otherTracked === 'changed'
  ) {
    process.stderr.write(
      chalk.red(`ERROR: Context changed but graph artifacts and source unchanged.\n`),
    );
    if (result.changedOther && result.changedOther.length > 0) {
      process.stderr.write(`  Upstream changes:\n`);
      for (const c of result.changedOther) {
        process.stderr.write(`    ${c.filePath} (${c.annotation})\n`);
      }
    }
    process.stderr.write(
      `  Review source compliance with updated context.\n`,
    );
    process.stderr.write(
      `  If source is already compliant: approve --reviewed "reason".\n`,
    );
    process.stderr.write(
      `  If source needs changes: update source + artifacts, then approve.\n`,
    );
    return;
  }

  // Fallback
  process.stderr.write(
    chalk.red(`ERROR: ${result.refuseReason ?? 'Approve refused.'}\n`),
  );
}

// ── Batch types and execution ─────────────────────────────────

export interface BatchResult {
  nodePath: string;
  result: ApproveResult;
}

/**
 * Worker-pool semaphore: runs approveOne on each node with at most
 * `concurrency` concurrent operations. Returns results in input order.
 */
export async function runBatch(
  nodes: string[],
  concurrency: number,
  approveOne: (nodePath: string) => Promise<ApproveResult>,
): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(nodes.length);
  const queue = [...nodes.entries()]; // [[0, 'path0'], [1, 'path1'], ...]
  const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, async () => {
    while (true) {
      const item = queue.shift(); // atomic in JS single-threaded event loop
      if (!item) break;
      const [i, nodePath] = item;
      results[i] = { nodePath, result: await approveOne(nodePath) };
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Filter E021 cascade issues by cause prefix.
 * Returns node paths whose cascadeCauses include files under the given prefix.
 */
export function filterCascadeNodes(
  issues: CheckIssue[],
  causePrefix: string,
): string[] {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'E021' || !issue.nodePath || !issue.cascadeCauses) continue;
    const hasMatchingCause = issue.cascadeCauses.some(
      (c: CascadeCause) => c.file.replace(/\\/g, '/').startsWith(causePrefix),
    );
    if (hasMatchingCause) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
}

function formatBatchOutput(results: BatchResult[], parallel: number): void {
  const total = results.length;
  let approved = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const { nodePath, result } = results[i];
    const prefix = parallel > 1 ? '' : `[${i + 1}/${total}] `;
    if (result.action === 'refused') {
      failed++;
      const reason = result.e055Violations?.length
        ? result.e055Violations.map(v => `E055 ${v.aspect}`).join(', ')
        : (result.refuseReason ?? 'refused');
      process.stdout.write(`${prefix}${nodePath.padEnd(50)} ${chalk.red('✗')} ${reason}\n`);
    } else {
      approved++;
      process.stdout.write(`${prefix}${nodePath.padEnd(50)} ${chalk.green('✓')} ${result.action}\n`);
    }
  }

  if (parallel > 1) process.stdout.write('\n');
  process.stdout.write(`${approved} approved, ${failed} failed.\n`);
}

// ── Reviewer provider loading ────────────────────────────────

async function loadLlmProvider(
  graph: { rootPath: string; config: { llm?: import('../model/graph.js').LlmConfig } },
): Promise<{ provider: LlmProvider | undefined; llmNotConfigured: boolean; maxTokens: number | undefined; consensus: number | undefined; cloudNotice: string | undefined }> {
  const llmConfig = graph.config.llm;
  if (!llmConfig) return { provider: undefined, llmNotConfigured: true, maxTokens: undefined, consensus: undefined, cloudNotice: undefined };

  const secrets = await loadSecrets(graph.rootPath, llmConfig.provider);
  const mergedConfig = secrets ? mergeLlmConfig(llmConfig, secrets) : llmConfig;
  const provider = createLlmProvider(mergedConfig);

  if (!(await provider.isAvailable())) {
    return { provider: undefined, llmNotConfigured: false, maxTokens: undefined, consensus: undefined, cloudNotice: undefined };
  }

  let cloudNotice: string | undefined;
  if (mergedConfig.provider !== 'ollama' && !sessionNoticeShown) {
    cloudNotice = `Source files will be sent to ${mergedConfig.provider} for verification. Use a local provider (ollama) to keep code private.`;
    sessionNoticeShown = true;
  }

  const maxTokens = mergedConfig.max_tokens === 'auto'
    ? (await provider.getContextWindowSize() ?? 8192)
    : (mergedConfig.max_tokens as number);

  return { provider, llmNotConfigured: false, maxTokens, consensus: mergedConfig.consensus, cloudNotice };
}

// ── Batch approve orchestrator ───────────────────────────────

async function runBatchApprove(
  graph: Graph,
  entityLabel: string,
  causePrefix: string,
  reviewed: string | undefined,
): Promise<boolean> {
  const issues = await classifyDrift(graph);
  const matchedNodes = filterCascadeNodes(issues, causePrefix);

  if (matchedNodes.length === 0) {
    process.stdout.write(`No cascade drift found for ${entityLabel}.\n`);
    return true;
  }

  const { provider, llmNotConfigured, maxTokens, consensus, cloudNotice } = await loadLlmProvider(graph);
  if (cloudNotice) {
    process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
  }

  const parallel = graph.config.parallel ?? 1;
  const sorted = matchedNodes.sort();

  if (parallel > 1) {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel} (parallel: ${parallel})...\n\n`);
  } else {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel}...\n`);
  }

  const results = await runBatch(sorted, parallel, (nodePath) =>
    approveNode(graph, nodePath, {
      reviewed,
      llmProvider: provider,
      llmNotConfigured,
      maxTokens,
      consensus,
      verifyAspects: graph.config.llm?.verify_aspects,
      verifyArtifacts: graph.config.llm?.verify_artifacts,
    }),
  );

  formatBatchOutput(results, parallel);
  return results.every(r => r.result.action !== 'refused');
}

// ── Command registration ─────────────────────────────────────

export function registerApproveCommand(program: Command): void {
  // `yg approve` — primary command
  program
    .command('approve')
    .description('Approve a node\'s current state, recording it as the new baseline')
    .option('--node <paths...>', 'One or more node paths to approve')
    .option('--aspect <id>', 'Batch approve all nodes with cascade drift from this aspect')
    .option('--flow <name>', 'Batch approve all nodes with cascade drift from this flow')
    .option('--reviewed <reason>', 'Bypasses three-axis gate — reviewer still verifies aspects')
    .action(async (options: { node?: string[]; aspect?: string; flow?: string; reviewed?: string }) => {
      try {
        // Validate: exactly one of --node, --aspect, --flow
        const targets = [options.node, options.aspect, options.flow].filter(Boolean);
        if (targets.length === 0) {
          process.stderr.write('ERROR: One of --node, --aspect, or --flow is required.\n');
          process.exit(1);
        }
        if (targets.length > 1) {
          process.stderr.write('ERROR: Only one of --node, --aspect, or --flow can be specified.\n');
          process.exit(1);
        }

        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath)
          .split(path.sep).join('/');

        // --aspect: batch approve all nodes with cascade drift from this aspect
        if (options.aspect) {
          const aspectId = options.aspect.trim();
          const aspectExists = graph.aspects.some(a => a.id === aspectId);
          if (!aspectExists) {
            process.stderr.write(chalk.red(`ERROR: Aspect '${aspectId}' does not exist.\n`));
            process.exit(1);
          }
          const causePrefix = `${yggPrefix}/aspects/${aspectId}/`;
          const allPassed = await runBatchApprove(graph, `aspect '${aspectId}'`, causePrefix, options.reviewed);
          process.exit(allPassed ? 0 : 1);
        }

        // --flow: batch approve all nodes with cascade drift from this flow
        if (options.flow) {
          const flowName = options.flow.trim();
          const flowExists = graph.flows.some(f => f.path === flowName);
          if (!flowExists) {
            process.stderr.write(chalk.red(`ERROR: Flow '${flowName}' does not exist.\n`));
            process.exit(1);
          }
          const causePrefix = `${yggPrefix}/flows/${flowName}/`;
          const allPassed = await runBatchApprove(graph, `flow '${flowName}'`, causePrefix, options.reviewed);
          process.exit(allPassed ? 0 : 1);
        }

        // --node: multi-node batch or single node
        if (options.node && options.node.length > 1) {
          const parallel = graph.config.parallel ?? 1;
          const nodePaths = options.node.map(n => n.trim().replace(/\/$/, ''));
          const { provider, llmNotConfigured, maxTokens, consensus, cloudNotice } = await loadLlmProvider(graph);
          if (cloudNotice) {
            process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
          }
          if (parallel > 1) {
            process.stdout.write(`Approving ${nodePaths.length} nodes (parallel: ${parallel})...\n\n`);
          } else {
            process.stdout.write(`Approving ${nodePaths.length} nodes...\n`);
          }
          const batchResults = await runBatch(nodePaths, parallel, (nodePath) =>
            approveNode(graph, nodePath, {
              reviewed: options.reviewed,
              llmProvider: provider,
              llmNotConfigured,
              maxTokens,
              consensus,
              verifyAspects: graph.config.llm?.verify_aspects,
      verifyArtifacts: graph.config.llm?.verify_artifacts,
            }),
          );
          formatBatchOutput(batchResults, parallel);
          const anyFailed = batchResults.some(r => r.result.action === 'refused');
          if (anyFailed) process.exit(1);
          return;
        }

        // Single node
        const nodePath = options.node![0].trim().replace(/\/$/, '');

        // No-mapping parent redirect to batch
        const node = graph.nodes.get(nodePath);
        if (!node) {
          process.stderr.write(chalk.red(`ERROR: Node '${nodePath}' does not exist.\n`));
          process.exit(1);
        }

        const mappingPaths = normalizeMappingPaths(node.meta.mapping);
        if (mappingPaths.length === 0) {
          const causePrefix = `${yggPrefix}/model/${nodePath}/`;
          const allPassed = await runBatchApprove(graph, `parent node '${nodePath}'`, causePrefix, options.reviewed);
          process.exit(allPassed ? 0 : 1);
        }

        // Has mapping — single node approve
        const { provider, llmNotConfigured, maxTokens, consensus, cloudNotice } = await loadLlmProvider(graph);
        if (cloudNotice) {
          process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
        }
        if (provider) {
          process.stdout.write(chalk.dim(`Verifying aspects with reviewer — this may take a while. Do not interrupt.\n`));
        }
        const result = await approveNode(graph, nodePath, {
          reviewed: options.reviewed,
          llmProvider: provider,
          llmNotConfigured,
          maxTokens,
          consensus,
          verifyAspects: graph.config.llm?.verify_aspects,
      verifyArtifacts: graph.config.llm?.verify_artifacts,
        });
        formatResult(nodePath, result);
        if (result.action === 'refused') {
          process.exit(1);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`ERROR: ${(error as Error).message}\n`));
        }
        process.exit(1);
      }
    });

  // `yg drift-sync` — backward-compatible alias
  program
    .command('drift-sync')
    .description(
      '[deprecated] Use "yg approve" instead. Backward-compatible alias for approving a node.',
    )
    .option('--node <path>', 'Node path to approve')
    .option('--reviewed <reason>', 'Bypasses three-axis gate — reviewer still verifies aspects')
    .option('--all', '(removed) use "yg approve --node" for each node')
    .option('--recursive', '(removed) approve one node at a time')
    .action(
      async (options: {
        node?: string;
        reviewed?: string;
        all?: boolean;
        recursive?: boolean;
      }) => {
        // Removed flags
        if (options.all) {
          process.stderr.write(
            chalk.red(
              'ERROR: --all has been removed. Approve one node at a time.\n',
            ),
          );
          process.exit(1);
        }
        if (options.recursive) {
          process.stderr.write(
            chalk.red(
              'ERROR: --recursive has been removed. Approve one node at a time.\n',
            ),
          );
          process.exit(1);
        }
        if (!options.node) {
          process.stderr.write(
            chalk.red('ERROR: --node <path> is required.\n'),
          );
          process.exit(1);
        }

        try {
          const graph = await loadGraph(process.cwd());
          initDebugLog(graph.rootPath, graph.config.debug ?? false);
          const nodePath = options.node.trim().replace(/\/$/, '');
          const { provider, llmNotConfigured, maxTokens, cloudNotice } = await loadLlmProvider(graph);
          if (cloudNotice) {
            process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
          }
          const result = await approveNode(graph, nodePath, {
            reviewed: options.reviewed,
            llmProvider: provider,
            llmNotConfigured,
            maxTokens,
            verifyAspects: graph.config.llm?.verify_aspects,
      verifyArtifacts: graph.config.llm?.verify_artifacts,
          });
          formatResult(nodePath, result);
          if (result.action === 'refused') {
            process.exit(1);
          }
        } catch (error) {
          process.stderr.write(chalk.red(`ERROR: ${(error as Error).message}\n`));
          process.exit(1);
        }
      },
    );
}

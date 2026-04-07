import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { approveNode } from '../core/approve.js';
import { createLlmProvider } from '../llm/provider.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import type { LlmProvider } from '../llm/types.js';
import type { ApproveResult } from '../model/types.js';

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
      if (result.claimResults || result.artifactReviewResults) {
        const claimCount = result.claimResults
          ? Object.values(result.claimResults).reduce((sum, claims) => sum + Object.keys(claims).length, 0)
          : 0;
        const artifactCount = result.artifactReviewResults
          ? Object.keys(result.artifactReviewResults).length
          : 0;
        process.stdout.write(`  Verified: ${claimCount} claims satisfied, ${artifactCount} artifacts current.\n`);
      }
      break;

    case 'acknowledged': {
      const isBlackboxCascade =
        result.isBlackbox && !result.blackboxBlocked && result.changedOther?.length;
      if (isBlackboxCascade) {
        process.stdout.write(chalk.green(`Acknowledged: ${nodePath} (blackbox, cascade)\n`));
        process.stdout.write(`  Hash: ${prev} -> ${curr}\n`);
        process.stdout.write(
          `  Note: upstream context changed, source not modified. Blackbox intact.\n`,
        );
      } else {
        process.stdout.write(chalk.green(`Acknowledged: ${nodePath}\n`));
        process.stdout.write(`  Hash: ${prev} -> ${curr}\n`);
        process.stdout.write(
          `  Approved as conscious exception — source and artifacts were not both updated.\n`,
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
      'not-configured': 'LLM not configured — claims not verified. Structural checks only.\n  To enable: configure llm section in yg-config.yaml.',
      'unavailable': 'LLM configured but not reachable — claims not verified. Structural checks only.',
      'acknowledge': 'LLM verification skipped (--acknowledge overrides).',
      'blackbox': 'LLM verification skipped for blackbox node.',
    };
    process.stdout.write(chalk.dim(`  ${messages[result.llmSkipped]}\n`));
    return;
  }

  if (result.claimResults) {
    process.stdout.write('\nAspect verification:\n');
    for (const [aspectId, claims] of Object.entries(result.claimResults)) {
      process.stdout.write(`  ${aspectId}:\n`);
      for (const [claimId, claimResult] of Object.entries(claims)) {
        if (claimResult.satisfied) {
          process.stdout.write(chalk.green(`    - "${claimId}" — SATISFIED\n`));
        } else {
          process.stdout.write(chalk.red(`    - "${claimId}" — NOT SATISFIED\n`));
          process.stdout.write(`        ${claimResult.reason}\n`);
        }
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
    if (result.acknowledgeAttempted) {
      process.stderr.write(
        chalk.red(`ERROR: Cannot acknowledge source changes on a blackbox node.\n`),
      );
      process.stderr.write(
        `  --acknowledge is not available for blackbox source changes.\n`,
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
      `  If change has no graph impact (formatting, comments): approve --acknowledge.\n`,
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
      `  If change has no source impact (typo, clarification): approve --acknowledge.\n`,
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
      `  If source is already compliant: approve --acknowledge.\n`,
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

// ── LLM provider loading ────────────────────────────────────

async function loadLlmProvider(
  graph: { rootPath: string; config: { llm?: import('../model/types.js').LlmConfig } },
): Promise<{ provider: LlmProvider | undefined; llmNotConfigured: boolean; maxTokens: number | undefined; consensus: number | undefined; cloudNotice: string | undefined }> {
  const llmConfig = graph.config.llm;
  if (!llmConfig) return { provider: undefined, llmNotConfigured: true, maxTokens: undefined, consensus: undefined, cloudNotice: undefined };

  const secrets = await loadSecrets(graph.rootPath);
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

// ── Command registration ─────────────────────────────────────

export function registerApproveCommand(program: Command): void {
  // `yg approve` — primary command
  program
    .command('approve')
    .description('Approve a node\'s current state, recording it as the new baseline')
    .requiredOption('--node <path>', 'Node path to approve')
    .option('--acknowledge <reason>', 'Conscious exception — approve without both source and artifacts changing')
    .action(async (options: { node: string; acknowledge?: string }) => {
      try {
        const graph = await loadGraph(process.cwd());
        const nodePath = options.node.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        const { provider, llmNotConfigured, maxTokens, consensus, cloudNotice } = await loadLlmProvider(graph);
        if (cloudNotice) {
          process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
        }
        const result = await approveNode(graph, nodePath, {
          acknowledge: options.acknowledge,
          llmProvider: provider,
          llmNotConfigured,
          maxTokens,
          consensus,
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
    });

  // `yg drift-sync` — backward-compatible alias
  program
    .command('drift-sync')
    .description(
      '[deprecated] Use "yg approve" instead. Backward-compatible alias for approving a node.',
    )
    .option('--node <path>', 'Node path to approve')
    .option('--acknowledge <reason>', 'Conscious exception — approve without both source and artifacts changing')
    .option('--all', '(removed) use "yg approve --node" for each node')
    .option('--recursive', '(removed) approve one node at a time')
    .action(
      async (options: {
        node?: string;
        acknowledge?: string;
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
          const nodePath = options.node.trim().replace(/^\.\//, '').replace(/\/+$/, '');
          const { provider, llmNotConfigured, maxTokens, cloudNotice } = await loadLlmProvider(graph);
          if (cloudNotice) {
            process.stdout.write(chalk.yellow(`Notice: ${cloudNotice}\n`));
          }
          const result = await approveNode(graph, nodePath, {
            acknowledge: options.acknowledge,
            llmProvider: provider,
            llmNotConfigured,
            maxTokens,
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

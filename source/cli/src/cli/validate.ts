import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { validate } from '../core/validator.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate graph structural integrity and completeness signals')
    .option('--scope <scope>', 'Scope: all or node-path (default: all)', 'all')
    .action(async (options: { scope: string }) => {
      try {
        const graph = await loadGraph(process.cwd(), { tolerateInvalidConfig: true });
        const rawScope = (options.scope ?? 'all').trim() || 'all';
        const scope = rawScope === 'all' ? 'all' : rawScope.replace(/^\.\//, '').replace(/\/+$/, '');
        const result = await validate(graph, scope);
        process.stdout.write(`${result.nodesScanned} nodes scanned\n\n`);
        const errors = result.issues.filter((i) => i.severity === 'error');
        const warnings = result.issues.filter((i) => i.severity === 'warning');
        for (const issue of errors) {
          const code = issue.code ?? '';
          const loc = issue.nodePath ?? '';
          const prefix = loc ? `${code} ${loc} -> ` : `${code} `;
          process.stdout.write(chalk.red(`✗ ${prefix}${issue.message}\n`));
        }
        for (const issue of warnings) {
          const code = issue.code ?? '';
          const loc = issue.nodePath ?? '';
          const prefix = loc ? `${code} ${loc} -> ` : `${code} `;
          process.stdout.write(chalk.yellow(`⚠ ${prefix}${issue.message}\n`));
        }
        if (errors.length === 0 && warnings.length === 0) {
          process.stdout.write(chalk.green('✓ No issues found.\n'));
        } else {
          process.stdout.write(`\n${errors.length} errors, ${warnings.length} warnings.\n`);
        }

        const hasErrors = result.issues.some((i) => i.severity === 'error');
        process.exit(hasErrors ? 1 : 0);
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}

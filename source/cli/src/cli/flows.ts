import { Command } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import type { Graph } from '../model/graph.js';
import { writeOut, count } from './output.js';

export function formatFlowsOutput(graph: Graph): string {
  if (graph.flows.length === 0) return '(no flows defined)\n';

  const lines: string[] = [];

  for (const flow of graph.flows.sort((a, b) => a.name.localeCompare(b.name))) {
    const displayName = flow.description
      ? `${flow.name} — ${flow.description}`
      : flow.name;
    lines.push(displayName);
    lines.push(`  Participants: ${count(flow.nodes.length, 'node')} (${flow.nodes.sort().join(', ')})`);
    if (flow.aspects && flow.aspects.length > 0) {
      lines.push(`  Aspects: ${flow.aspects.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function registerFlowsCommand(program: Command): void {
  program
    .command('flows')
    .description('List flows with participant counts and aspects')
    .action(async () => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        writeOut(formatFlowsOutput(graph));
      } catch (error) {
        abortOnUnexpectedError(error, 'listing flows');
      }
    });
}

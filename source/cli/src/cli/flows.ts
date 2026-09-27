import { Command } from 'commander';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import type { Graph } from '../model/graph.js';
import { writeOut, count, warn } from './output.js';

export function formatFlowsOutput(graph: Graph): string {
  if (graph.flows.length === 0) return (graph.flowParseErrors ?? []).length > 0 ? '(no flow loaded)\n' : '(no flows defined)\n';

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
        // A flow that did not load is not listed — it gives its participants
        // nothing — but it is not left out in silence either: each one is the
        // same finding yg check reports, on stderr.
        for (const { messageData } of [...(graph.flowParseErrors ?? [])].sort((a, b) => a.flowPath.localeCompare(b.flowPath))) {
          warn(messageData, 'yaml-invalid');
        }
      } catch (error) {
        abortOnUnexpectedError(error, 'listing flows');
      }
    });
}

import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { NODE_JSON_SCHEMA, formatNodeJson } from '../formatters/node-json.js';
import type { NodeJsonDocument } from '../formatters/node-json.js';
import { buildNodeDocument } from '../core/graph/machine-documents.js';
import { toPosixPath } from '../utils/posix.js';

/** `(none)` rather than an empty line, so an absent section never reads as a missing one. */
const NONE = '(none)';

/** The text view — one component's structure for a person, from the same document the machine form emits. */
function renderNodeText(doc: NodeJsonDocument): string {
  const lines: string[] = [];
  lines.push(`${doc.path} — ${doc.name} [${doc.type}]`);
  if (doc.description) lines.push(`  ${doc.description}`);
  lines.push('');

  lines.push('Hierarchy:');
  lines.push(`  parent: ${doc.parent ?? NONE}`);
  lines.push(`  children: ${doc.children.length > 0 ? doc.children.join(', ') : NONE}`);
  lines.push('');

  lines.push(`Owns (${doc.mapping.length}):`);
  if (doc.mapping.length === 0) lines.push(`  ${NONE}`);
  for (const entry of doc.mapping) lines.push(`  ${entry}`);
  lines.push('');

  lines.push(`Depends on (${doc.relations.length}):`);
  if (doc.relations.length === 0) lines.push(`  ${NONE}`);
  for (const rel of doc.relations) {
    const detail = [rel.type];
    if (rel.consumes.length > 0) detail.push(`consumes: ${rel.consumes.join(', ')}`);
    if (rel.event_name !== undefined) detail.push(`event: ${rel.event_name}`);
    lines.push(`  -> ${rel.target} (${detail.join(', ')})`);
  }
  lines.push('');

  const portNames = Object.keys(doc.ports);
  lines.push(`Ports (${portNames.length}):`);
  if (portNames.length === 0) lines.push(`  ${NONE}`);
  for (const name of portNames) {
    const port = doc.ports[name];
    lines.push(`  ${name} — ${port.description}`);
    lines.push(`    version: ${port.version ?? NONE}   test: ${port.test ?? NONE}`);
    lines.push(`    consumers must satisfy: ${port.aspects.length > 0 ? port.aspects.join(', ') : NONE}`);
  }
  lines.push('');

  lines.push(`Rules in force here: yg context --node ${doc.path}`);
  return `${lines.join('\n')}\n`;
}

export function registerNodeCommand(program: Command): void {
  program
    .command('node')
    .description('Show one component: what it is, what it owns, what it depends on, and the ports it publishes')
    .argument('<path>', 'Node path relative to .yggdrasil/model/')
    .option('--json', `Machine-readable output: one ${NODE_JSON_SCHEMA} document on stdout instead of the text view.`)
    .action(async (pathArg: string, options: { json?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        const nodePath = toPosixPath(pathArg.trim());
        if (!graph.nodes.has(nodePath)) {
          process.stderr.write(
            chalk.red(
              `Error: ${buildIssueMessage({
                what: `Node '${nodePath}' does not exist in the graph.`,
                why: 'The path must name an existing component — a directory under .yggdrasil/model/, written without the model/ prefix.',
                next: 'Browse the graph with yg tree, or locate one with yg find "<keywords>", then retry with a valid path.',
              })}\n`,
            ),
          );
          process.exit(1);
        }

        const doc = buildNodeDocument(graph, nodePath);
        process.stdout.write(options.json === true ? formatNodeJson(doc) : renderNodeText(doc));
      } catch (error) {
        debugWrite(`[node] command failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'reading the component');
      }
    });
}

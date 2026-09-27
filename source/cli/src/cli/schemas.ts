import { Command } from 'commander';
import { SCHEMA_TOPICS } from '../templates/schemas/index.js';
import { FILE_FORMATS, fileFormat } from '../utils/file-formats.js';
import { renderFieldTable } from '../utils/file-schema.js';
import { abortOnUnexpectedError } from './preamble.js';
import { paint, writeOut, failAndExit } from './output.js';

/**
 * One entry per file format the CLI reads. The list, each summary and each
 * field table come from the schema objects the parsers enforce
 * (utils/file-formats*.ts); the annotated example above a field table is the
 * format's schema document (templates/schemas/).
 */
export function listSchemas(): void {
  writeOut('\nAvailable schemas:\n\n');
  const sorted = [...FILE_FORMATS].sort((a, b) => a.name.localeCompare(b.name));
  for (const format of sorted) {
    writeOut(`  ${paint.bold(format.name.padEnd(28))} ${format.summary}\n`);
  }
  writeOut('\nTo read a schema: yg schemas read <name>\n\n');
}

export function readSchema(name: string): void {
  // Own-property guard: an inherited Object.prototype key ('constructor',
  // 'toString', '__proto__', …) is truthy on SCHEMA_TOPICS via the prototype
  // chain, so a bare `SCHEMA_TOPICS[name] === undefined` check would let it
  // through and then crash on `topic.content` with the generic "this is a bug"
  // abort instead of the guided unknown-schema error. Mirror readKnowledge.
  const format = fileFormat(name);
  if (format === undefined || !Object.prototype.hasOwnProperty.call(SCHEMA_TOPICS, name)) {
    const available = FILE_FORMATS.map((f) => f.name).sort().join(', ');
    failAndExit({
          what: `Unknown schema '${name}'.`,
          why: 'The schema name does not match any file format the CLI reads.',
          next: `Available: ${available}. Run 'yg schemas list' for summaries.`,
        }, 'command-error');
  }
  const topic = SCHEMA_TOPICS[name];
  writeOut(topic.content);
  writeOut(`\n# Fields of ${format.file} — the schema the parser enforces\n\n${renderFieldTable(format)}\n`);
}

export function registerSchemasCommand(program: Command): void {
  const schemas = program
    .command('schemas')
    .description('File-format schemas — field reference for every YAML file the CLI reads (graph, config, packages)');

  schemas
    .command('list')
    .description('List every file-format schema with its summary')
    .action(() => {
      try {
        listSchemas();
      } catch (error) {
        abortOnUnexpectedError(error, 'listing schemas');
      }
    });

  schemas
    .command('read <name>')
    .description('Print a file format\'s annotated example and its field table')
    .action((name: string) => {
      try {
        readSchema(name);
      } catch (error) {
        abortOnUnexpectedError(error, 'reading schema');
      }
    });
}

import { Command } from 'commander';
import { SCHEMA_TOPICS } from '../templates/schemas/index.js';
import { abortOnUnexpectedError } from './preamble.js';
import { fail, paint, writeOut } from './output.js';

export function listSchemas(): void {
  writeOut('\nAvailable schemas:\n\n');
  const sorted = Object.entries(SCHEMA_TOPICS).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, topic] of sorted) {
    writeOut(`  ${paint.bold(name.padEnd(28))} ${topic.summary}\n`);
  }
  writeOut('\nTo read a schema: yg schemas read <name>\n\n');
}

export function readSchema(name: string): void {
  // Own-property guard: an inherited Object.prototype key ('constructor',
  // 'toString', '__proto__', …) is truthy on SCHEMA_TOPICS via the prototype
  // chain, so a bare `SCHEMA_TOPICS[name] === undefined` check would let it
  // through and then crash on `topic.content` with the generic "this is a bug"
  // abort instead of the guided unknown-schema error. Mirror readKnowledge.
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_TOPICS, name)) {
    const available = Object.keys(SCHEMA_TOPICS).sort().join(', ');
    fail({
          what: `Unknown schema '${name}'.`,
          why: 'The schema name does not match any embedded graph-element schema.',
          next: `Available: ${available}. Run 'yg schemas list' for summaries.`,
        });
    process.exit(1);
  }
  const topic = SCHEMA_TOPICS[name];
  writeOut(topic.content);
}

export function registerSchemasCommand(program: Command): void {
  const schemas = program
    .command('schemas')
    .description('Graph-element schemas — field reference for nodes, aspects, architecture, config, flows');

  schemas
    .command('list')
    .description('List all available graph-element schemas with summaries')
    .action(() => {
      try {
        listSchemas();
      } catch (error) {
        abortOnUnexpectedError(error, 'listing schemas');
      }
    });

  schemas
    .command('read <name>')
    .description('Print the full reference for a graph-element schema')
    .action((name: string) => {
      try {
        readSchema(name);
      } catch (error) {
        abortOnUnexpectedError(error, 'reading schema');
      }
    });
}

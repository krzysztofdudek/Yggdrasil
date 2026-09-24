import { Command } from 'commander';
import { KNOWLEDGE_TOPICS } from '../templates/knowledge/index.js';
import { abortOnUnexpectedError } from './preamble.js';
import { fail, paint, writeOut } from './output.js';

export function listKnowledge(): void {
  writeOut('\nAvailable knowledge topics:\n\n');
  const sorted = Object.entries(KNOWLEDGE_TOPICS).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, topic] of sorted) {
    writeOut(`  ${paint.bold(name.padEnd(28))} ${topic.summary}\n`);
  }
  writeOut('\nTo read a topic: yg knowledge read <name>\n\n');
}

export function readKnowledge(name: string): void {
  if (!Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOPICS, name)) {
    const available = Object.keys(KNOWLEDGE_TOPICS).sort().join(', ');
    fail({
          what: `Unknown knowledge topic '${name}'.`,
          why: 'The topic name does not match any entry in the embedded knowledge base.',
          next: `Available: ${available}. Run 'yg knowledge list' for summaries.`,
        });
    process.exit(1);
  }
  const topic = KNOWLEDGE_TOPICS[name];
  writeOut(topic.content);
}

export function registerKnowledgeCommand(program: Command): void {
  const knowledge = program
    .command('knowledge')
    .description('Knowledge base — deep-dive topics on Yggdrasil mechanisms');

  knowledge
    .command('list')
    .description('List all available knowledge topics with summaries')
    .action(() => {
      try {
        listKnowledge();
      } catch (error) {
        abortOnUnexpectedError(error, 'listing knowledge topics');
      }
    });

  knowledge
    .command('read <name>')
    .description('Print the full content of a knowledge topic')
    .action((name: string) => {
      try {
        readKnowledge(name);
      } catch (error) {
        abortOnUnexpectedError(error, 'reading knowledge topic');
      }
    });
}

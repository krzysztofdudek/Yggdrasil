import { Command } from 'commander';
import chalk from 'chalk';
import { KNOWLEDGE_TOPICS } from '../templates/knowledge/index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { abortOnUnexpectedError } from './preamble.js';

export function listKnowledge(): void {
  process.stdout.write('\nAvailable knowledge topics:\n\n');
  const sorted = Object.entries(KNOWLEDGE_TOPICS).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, topic] of sorted) {
    process.stdout.write(`  ${chalk.bold(name.padEnd(28))} ${topic.summary}\n`);
  }
  process.stdout.write('\nTo read a topic: yg knowledge read <name>\n\n');
}

export function readKnowledge(name: string): void {
  if (!Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOPICS, name)) {
    const available = Object.keys(KNOWLEDGE_TOPICS).sort().join(', ');
    process.stderr.write(
      chalk.red(
        `Error: ${buildIssueMessage({
          what: `Unknown knowledge topic '${name}'.`,
          why: 'The topic name does not match any entry in the embedded knowledge base.',
          next: `Available: ${available}. Run 'yg knowledge list' for summaries.`,
        })}\n`,
      ),
    );
    process.exit(1);
  }
  const topic = KNOWLEDGE_TOPICS[name];
  process.stdout.write(topic.content);
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

import { Command } from 'commander';
import { KNOWLEDGE_TOPICS, KNOWLEDGE_TOPIC_ALIASES } from '../templates/knowledge/index.js';
import { abortOnUnexpectedError } from './preamble.js';
import { paint, writeOut, failAndExit } from './output.js';

export function listKnowledge(): void {
  writeOut('\nAvailable knowledge topics:\n\n');
  const sorted = Object.entries(KNOWLEDGE_TOPICS).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, topic] of sorted) {
    const aliases = Object.keys(KNOWLEDGE_TOPIC_ALIASES).filter((a) => KNOWLEDGE_TOPIC_ALIASES[a] === name);
    const also = aliases.length > 0 ? ` (also: ${aliases.join(', ')})` : '';
    writeOut(`  ${paint.bold(name.padEnd(28))} ${topic.summary}${also}\n`);
  }
  writeOut('\nTo read a topic: yg knowledge read <name>\n\n');
}

export function readKnowledge(requested: string): void {
  const name = Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOPIC_ALIASES, requested)
    ? KNOWLEDGE_TOPIC_ALIASES[requested]
    : requested;
  if (!Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOPICS, name)) {
    const available = Object.keys(KNOWLEDGE_TOPICS).sort().join(', ');
    failAndExit({
          what: `Unknown knowledge topic '${name}'.`,
          why: 'The topic name does not match any entry in the embedded knowledge base.',
          next: `Available: ${available}. Run 'yg knowledge list' for summaries.`,
        }, 'command-error');
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

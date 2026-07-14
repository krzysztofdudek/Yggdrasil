import type { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { quoteData } from '../core/advise-nominations.js';
import {
  appendIncident,
  readIncidents,
  isValidIncidentTag,
  INCIDENT_TAGS,
  INCIDENTS_FILENAME,
} from '../io/incidents-store.js';

function handleError(error: unknown): never {
  debugWrite(`[incident] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running incident command');
}

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: { what: string; why: string; next: string }): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

export function registerIncidentCommand(program: Command): void {
  const incident = program
    .command('incident')
    .description(
      'The incident ledger — a committed record of what escaped enforcement and how, the tower\'s only external reality check (read-only; add appends one human-signed entry)',
    );

  incident
    .command('add')
    .description('Record what escaped enforcement and how it surfaced, tagged by cause')
    .requiredOption(
      '--tag <cause>',
      `Cause of the escape (one of: ${INCIDENT_TAGS.join(', ')})`,
    )
    .requiredOption('--reason <text>', 'What escaped and how it surfaced (mandatory human testimony)')
    .option(
      '--aspect <id>',
      'Attribute this escape to one existing rule by id — mainly for --tag wrong-rule, naming the miscalibrated rule so per-rule health can surface it. Optional; omit for an unattributed incident.',
    )
    .action(async (opts: { tag: string; reason: string; aspect?: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });

        if (!isValidIncidentTag(opts.tag)) {
          failWith({
            what: `--tag '${opts.tag}' is not a recognized incident cause.`,
            why: 'Each incident is tagged by CAUSE so the shape of what enforcement misses stays legible; an unknown tag would make that record meaningless.',
            next: `Re-run with one of: ${INCIDENT_TAGS.join(', ')}.`,
          });
        }

        if (opts.reason.trim() === '') {
          failWith({
            what: 'An incident needs a non-empty --reason.',
            why: 'The ledger is human testimony: the entry must say WHAT escaped and HOW it surfaced, or it records nothing worth committing.',
            next: 'Re-run with --reason "<what escaped enforcement and how it surfaced>".',
          });
        }

        // Optional per-rule attribution. When present, the id MUST name an existing
        // aspect — validated exactly like an unknown --tag: attributing an escape to a
        // rule that does not exist would poison the per-rule health signal, so it is
        // rejected before anything is written.
        if (opts.aspect !== undefined && !graph.aspects.some((a) => a.id === opts.aspect)) {
          failWith({
            what: `--aspect '${opts.aspect}' is not an aspect declared in this graph.`,
            why: 'Per-rule attribution names the miscalibrated rule so per-rule health can surface it against the right rule; an unknown id would attribute the escape to a rule that does not exist.',
            next: 'List the declared rules with yg aspects, then re-run with --aspect <existing-aspect-id> — or omit --aspect to record an unattributed incident.',
          });
        }

        // Injected UTC clock at the boundary (wave-5/6 pattern) — the store keeps no
        // Date.now of its own, so tests can pin the datetime deterministically.
        const isoDatetime = new Date().toISOString();
        appendIncident(graph.rootPath, {
          tag: opts.tag,
          reason: opts.reason,
          isoDatetime,
          aspect: opts.aspect,
        });

        process.stdout.write(
          chalk.green(
            `Recorded incident [${opts.tag}]${opts.aspect !== undefined ? ` attributed to ${opts.aspect}` : ''} at ${isoDatetime} in .yggdrasil/${INCIDENTS_FILENAME}\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });

  incident
    .command('read')
    .description('List recorded incidents (datetime and cause, oldest first); the full testimony lives in the committed ledger file')
    .action(async () => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const { entries, present } = readIncidents(graph.rootPath);
        if (!present || entries.length === 0) {
          process.stdout.write('No incidents recorded.\n');
          return;
        }
        process.stdout.write(
          `${entries.length} incident${entries.length === 1 ? '' : 's'} on record:\n\n`,
        );
        for (const entry of entries) {
          // The tag is captured verbatim from a possibly hand-edited committed header,
          // so it may carry control bytes. Neutralize it through the same helper the
          // advise feed uses to render untrusted repo strings as inert inline data —
          // a raw control byte must never reach the terminal.
          process.stdout.write(`## [${entry.datetime}] ${quoteData(entry.tag)}\n`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}

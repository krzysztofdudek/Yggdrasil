#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './cli/init.js';
import { registerBuildCommand } from './cli/build-context.js';
import { registerValidateCommand } from './cli/validate.js';
import { registerDriftCommand } from './cli/drift.js';
import { registerDriftSyncCommand } from './cli/drift-sync.js';
import { registerStatusCommand } from './cli/status.js';
import { registerTreeCommand } from './cli/tree.js';
import { registerOwnerCommand } from './cli/owner.js';
import { registerDepsCommand } from './cli/deps.js';
import { registerImpactCommand } from './cli/impact.js';
import { registerAspectsCommand } from './cli/aspects.js';
import { registerFlowsCommand } from './cli/flows.js';
import { registerJournalAddCommand } from './cli/journal-add.js';
import { registerJournalReadCommand } from './cli/journal-read.js';
import { registerJournalArchiveCommand } from './cli/journal-archive.js';
import { registerPreflightCommand } from './cli/preflight.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('yg')
  .description('Yggdrasil — architectural knowledge infrastructure for AI agents')
  .version(pkg.version);

registerInitCommand(program);
registerBuildCommand(program);
registerValidateCommand(program);
registerDriftCommand(program);
registerDriftSyncCommand(program);
registerStatusCommand(program);
registerTreeCommand(program);
registerOwnerCommand(program);
registerDepsCommand(program);
registerImpactCommand(program);
registerAspectsCommand(program);
registerFlowsCommand(program);
registerJournalAddCommand(program);
registerJournalReadCommand(program);
registerJournalArchiveCommand(program);
registerPreflightCommand(program);

program.parse();

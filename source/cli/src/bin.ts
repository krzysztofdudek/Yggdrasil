#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './cli/init.js';
import { registerBuildCommand } from './cli/build-context.js';
import { registerApproveCommand } from './cli/approve.js';
import { registerTreeCommand } from './cli/tree.js';
import { registerOwnerCommand } from './cli/owner.js';
import { registerImpactCommand } from './cli/impact.js';
import { registerAspectsCommand } from './cli/aspects.js';
import { registerFlowsCommand } from './cli/flows.js';
import { registerCheckCommand } from './cli/check.js';
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
registerApproveCommand(program);
registerTreeCommand(program);
registerOwnerCommand(program);
registerImpactCommand(program);
registerAspectsCommand(program);
registerFlowsCommand(program);
registerCheckCommand(program);

program.parse();

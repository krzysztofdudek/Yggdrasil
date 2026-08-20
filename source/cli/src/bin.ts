#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './cli/init.js';
import { registerBuildCommand } from './cli/build-context.js';
import { registerTreeCommand } from './cli/tree.js';
import { registerOwnerCommand } from './cli/owner.js';
import { registerImpactCommand } from './cli/impact.js';
import { registerAspectsCommand } from './cli/aspects.js';
import { registerFlowsCommand } from './cli/flows.js';
import { registerCheckCommand } from './cli/check.js';
import { registerAspectTestCommand } from './cli/aspect-test.js';
import { registerDrillCommand } from './cli/drill.js';
import { registerLogCommand } from './cli/log.js';
import { registerAdviseCommand } from './cli/advise.js';
import { registerIncidentCommand } from './cli/incident.js';
import { registerFindCommand } from './cli/find.js';
import { registerTypeSuggestCommand } from './cli/type-suggest.js';
import { registerKnowledgeCommand } from './cli/knowledge.js';
import { registerSchemasCommand } from './cli/schemas.js';
import { registerSuppressionsCommand } from './cli/suppressions.js';
import { registerSimulateCommand } from './cli/simulate.js';
import { registerPortalCommand } from './cli/portal.js';
import { registerStructureCommand } from './cli/structure.js';
import { registerPrimeCommand } from './cli/prime.js';
import { registerRootsCommand } from './cli/roots.js';
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
registerTreeCommand(program);
registerOwnerCommand(program);
registerImpactCommand(program);
registerAspectsCommand(program);
registerFlowsCommand(program);
registerCheckCommand(program);
registerAspectTestCommand(program);
registerDrillCommand(program);
registerLogCommand(program);
registerAdviseCommand(program);
registerIncidentCommand(program);
registerFindCommand(program);
registerTypeSuggestCommand(program);
registerKnowledgeCommand(program);
registerSchemasCommand(program);
registerSuppressionsCommand(program);
registerSimulateCommand(program);
registerPortalCommand(program);
registerStructureCommand(program);
registerPrimeCommand(program);
registerRootsCommand(program);

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
});

try {
  program.parse();
} catch (err) {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
}

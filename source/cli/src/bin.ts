#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './cli/init.js';
import { registerAdoptCommand } from './cli/adopt.js';
import { registerBuildCommand } from './cli/build-context.js';
import { registerTreeCommand } from './cli/tree.js';
import { registerOwnerCommand } from './cli/owner.js';
import { registerImpactCommand } from './cli/impact.js';
import { registerNodeCommand } from './cli/node.js';
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
import { registerPackCommand } from './cli/pack.js';
import { registerMarketplaceCommand } from './cli/marketplace.js';
import { registerPrimeCommand } from './cli/prime.js';
import { registerRemovedVerdictCommand } from './cli/verdict-removed.js';
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
  // Options belong to the command they follow. Without this, a command that has
  // subcommands of its own swallows a flag of the same name before the
  // subcommand is ever reached — so `yg drill add --aspect <id>` would be told
  // the flag it just supplied is missing. Every command's own options still come
  // after its name, exactly as before; what changes is only that a flag written
  // after a SUBcommand name is that subcommand's.
  .enablePositionalOptions()
  .version(pkg.version);

registerInitCommand(program);
registerAdoptCommand(program);
registerBuildCommand(program);
registerTreeCommand(program);
registerOwnerCommand(program);
registerImpactCommand(program);
registerNodeCommand(program);
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
registerPackCommand(program);
registerMarketplaceCommand(program);
registerPrimeCommand(program);
registerRemovedVerdictCommand(program);

/**
 * A reader that closes its end of our output pipe (`yg check --approve | head`)
 * must not abort the run: the fill keeps going, persists every verdict and
 * exits with its own code. The first EPIPE turns further writes to that stream
 * into no-ops (nobody is reading them); any other stream error stays fatal.
 */
function tolerateClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      stream.write = (() => true) as typeof stream.write;
      return;
    }
    throw err;
  });
}
tolerateClosedPipe(process.stdout);
tolerateClosedPipe(process.stderr);

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

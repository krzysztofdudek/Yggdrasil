import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

/** The policy file, inside the call's private directory, that --policy names. */
const POLICY_FILE = 'deny-all-tools.toml';

/**
 * One policy rule denying every tool, built-in or MCP. A globally denied tool
 * is removed from what the model is offered, not just refused when called.
 */
const DENY_ALL_TOOLS_POLICY = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';

/**
 * An MCP allow-list entry naming no real server. An allow-list that is present
 * admits only the servers it names, so this admits none; an EMPTY entry is not
 * an option, because the CLI refuses it at startup ("mcpName is required").
 */
const NO_MCP_SERVER = 'yg-reviewer-allows-no-mcp-server';

// Verified against @google/gemini-cli 0.61.0 (`gemini --help`, its bundled
// source, and headless runs against a local stub API that recorded the tools
// each run offered the model). Each flag removes one way the agent could act
// or pull in outside context:
//   -o text                    the reply alone on stdout; `-o json` wraps it in
//                              an envelope as an escaped string, which no
//                              verdict parser can read
//   --skip-trust               headless gemini refuses to start in a directory
//                              it has not been told to trust; the one trusted
//                              here is the call's own empty directory
//   --approval-mode plan       read-only mode
//   -e none                    no extensions
//   --allowed-mcp-server-names no MCP servers (see NO_MCP_SERVER)
//   --policy <deny-all>        no tools offered to the model at all
// The working directory is the call's own empty directory, so no GEMINI.md or
// .gemini/ settings from the shared temp directory are loaded. What remains is
// the user's own ~/.gemini (the login lives there, beside the user-level
// GEMINI.md and settings) — nothing the reviewed repository can write to.
// The prompt goes on stdin (the CLI runs non-interactively on piped input): a
// large component's prompt is past what one argument may carry on Linux (128 KiB)
// and past a whole Windows command line (32,767 characters), and an argument is
// visible to every local user in the process list.
export class GeminiCliProvider extends CliAgentProvider {
  get binary() { return 'gemini'; }
  get stdinMode() { return true; }
  protected get installHint() { return 'install the Gemini CLI (npm i -g @google/gemini-cli) and sign in by running `gemini` once'; }
  protected get usesPrivateWorkDir(): boolean { return true; }

  protected prepareWorkDir(dir: string): void {
    writeFileSync(path.join(dir, POLICY_FILE), DENY_ALL_TOOLS_POLICY);
  }

  buildArgs(_prompt: string, workDir?: string): string[] {
    const dir = workDir ?? '.';
    return [
      '-o', 'text',
      '-m', this.model,
      '--skip-trust',
      '--approval-mode', 'plan',
      '-e', 'none',
      '--allowed-mcp-server-names', NO_MCP_SERVER,
      '--policy', path.join(dir, POLICY_FILE),
    ];
  }
}

registerProvider('gemini-cli', (c) => new GeminiCliProvider({ model: c.model, timeout: c.timeout }));

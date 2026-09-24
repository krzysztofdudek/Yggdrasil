import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

/** The file, inside the call's private directory, that --output-schema names. */
const SCHEMA_FILE = 'verdict-schema.json';

/**
 * The reply shape codex is held to. Structured output wants every property
 * required and no others, so the schema says so rather than leaving it to the
 * model.
 */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { satisfied: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['satisfied', 'reason'],
  additionalProperties: false,
};

// Verified against codex-cli 0.156.1 (`codex exec --help`, and headless runs
// against a local Responses stub that recorded the tools each run offered the
// model). The reviewer gets a self-contained prompt and needs nothing else, so
// every way the agent could act or pull in outside context is switched off:
//   --skip-git-repo-check      the call runs in an empty temp directory, not a
//                              repository; without this codex refuses to start
//   --sandbox read-only        no writes and no network from anything it runs
//   --ephemeral                no session files written
//   --ignore-user-config       no ~/.codex/config.toml, so none of its MCP
//                              servers, profiles or provider overrides (the
//                              login in CODEX_HOME still applies)
//   --ignore-rules             no user or project execpolicy rules
//   --color never              the reply reaches stdout as plain text
//   --disable shell_tool, view_image, multi_agent, goals, and
//   -c web_search=disabled     no shell, image, sub-agent, goal or web-search
//                              tool is offered to the model at all
//   -C <private dir>           its working root is the call's own empty
//                              directory, so no AGENTS.md or .codex/ is found
// No --json: that prints the run's event stream, in which the reply is an
// escaped string, so the verdict could never be read. Without it, stdout
// carries the final reply alone.
const ISOLATION_ARGS: string[] = [
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--color', 'never',
  '--disable', 'shell_tool',
  '--disable', 'view_image',
  '--disable', 'multi_agent',
  '--disable', 'goals',
  '-c', 'web_search=disabled',
];

export class CodexProvider extends CliAgentProvider {
  get binary() { return 'codex'; }
  get stdinMode() { return true; }
  protected get installHint() { return 'install the Codex CLI (npm i -g @openai/codex) and sign in with `codex login`'; }
  protected get usesPrivateWorkDir(): boolean { return true; }

  protected prepareWorkDir(dir: string): void {
    writeFileSync(path.join(dir, SCHEMA_FILE), JSON.stringify(VERDICT_SCHEMA));
  }

  buildArgs(_prompt: string, workDir?: string): string[] {
    // The private directory always exists when a call builds its argv; the
    // fallback only keeps a direct buildArgs() call (tests, previews) total.
    const dir = workDir ?? '.';
    return ['exec', ...ISOLATION_ARGS, '-C', dir, '-m', this.model, '--output-schema', path.join(dir, SCHEMA_FILE), '-'];
  }
}

registerProvider('codex', (c) => new CodexProvider({ model: c.model, timeout: c.timeout }));

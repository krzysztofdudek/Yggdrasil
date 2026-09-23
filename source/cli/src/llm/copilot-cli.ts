import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';
import type { AspectResponse } from './types.js';
import { probeBinary } from '../utils/binary-check.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * Where the GitHub Copilot CLI lives on this machine, or null.
 *
 * `copilot` on PATH is not always the CLI. The VS Code Copilot extension ships a
 * stub of that name under its own global storage (`.../github.copilot-chat/copilotCli/copilot`),
 * and the extension puts it on PATH ahead of a real install; run, it asks
 * interactively whether to install the CLI. A reviewer that spawned it would wait
 * on a question nobody sees and come back "unavailable". So the binary is found on
 * purpose: `YG_COPILOT_BIN` when it names a file, otherwise the first `copilot` on
 * PATH that is not under the extension's storage.
 */
export function resolveCopilotBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.YG_COPILOT_BIN;
  if (explicit && isFile(explicit)) return toPosixPath(explicit);
  const names = process.platform === 'win32' ? ['copilot.exe', 'copilot.cmd', 'copilot'] : ['copilot'];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || isExtensionStub(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return toPosixPath(candidate);
    }
  }
  return null;
}

/**
 * Why no Copilot CLI was found, naming what was there instead: a YG_COPILOT_BIN
 * that is not a file, or the VS Code extension's stub sitting alone on PATH.
 */
export function copilotNotFoundReason(env: NodeJS.ProcessEnv = process.env): string {
  const install = 'install it (npm i -g @github/copilot) or set YG_COPILOT_BIN to its path';
  const explicit = env.YG_COPILOT_BIN;
  if (explicit && !isFile(explicit)) return `YG_COPILOT_BIN is set to '${explicit}', which is not a file — point it at the GitHub Copilot CLI, or unset it and ${install}`;
  const names = process.platform === 'win32' ? ['copilot.exe', 'copilot.cmd', 'copilot'] : ['copilot'];
  const stub = (env.PATH ?? '').split(path.delimiter).find((dir) => dir && isExtensionStub(dir) && names.some((n) => isFile(path.join(dir, n))));
  if (stub) return `the only 'copilot' on PATH is the VS Code Copilot extension's (${toPosixPath(stub)}), which is an installer prompt, not the CLI — ${install}`;
  return `GitHub Copilot CLI not found on PATH — ${install}; the copilot inside the VS Code extension is an installer prompt, not the CLI`;
}

/** The VS Code extension's own copy, which is an installer prompt and not the CLI. */
export function isExtensionStub(p: string): boolean {
  return /github\.copilot-chat[\\/]copilotCli/.test(p);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

// The reviewer gets a self-contained prompt and needs nothing else, so every source
// of outside context the CLI would otherwise bring in is switched off:
//   --no-ask-user              never stop to ask a question nobody will answer
//   --no-custom-instructions   no AGENTS.md or other repository instructions
//   --disable-builtin-mcps     no built-in MCP servers
//   --deny-tool …              no shell, file writes, network or memory
//   --no-auto-update           no update check inside a review
// The user's own configuration and MCP servers live in COPILOT_HOME, which the
// provider points at an empty directory of its own (see extraEnv); the login
// survives that, because the CLI keeps its credentials outside it.
const ISOLATION_ARGS: string[] = [
  '--no-ask-user',
  '--no-custom-instructions',
  '--disable-builtin-mcps',
  '--deny-tool', 'shell',
  '--deny-tool', 'write',
  '--deny-tool', 'url',
  '--deny-tool', 'memory',
  '--no-auto-update',
];

let isolatedHome: string | null = null;
function copilotHome(): string {
  if (isolatedHome === null) {
    isolatedHome = mkdtempSync(path.join(tmpdir(), 'yg-copilot-home-'));
    const made = isolatedHome;
    process.once('exit', () => {
      try { rmSync(made, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }
  return isolatedHome;
}

export class CopilotCliProvider extends CliAgentProvider {
  // The model is never defaulted: an organisation's Copilot policy decides which
  // models a seat may use, and the CLI refuses one outside it rather than
  // substituting another, so only the configuration can name it.
  get binary() { return resolveCopilotBinary() ?? 'copilot'; }
  // The prompt goes on stdin (the CLI reads it there when no -p is given, non-interactively): a
  // large component's prompt is past what one argument may carry on Linux (128 KiB) and past a
  // whole Windows command line (32,767 characters).
  get stdinMode() { return true; }
  // npm installs the CLI on Windows as a `.cmd` shim, which only a shell can start. The arguments
  // are then fixed flags plus the model name, which is checked below before it can reach a shell.
  protected get spawnShell(): boolean { return /\.(cmd|bat)$/i.test(this.binary); }
  protected get extraEnv(): Record<string, string> { return { COPILOT_HOME: copilotHome() }; }

  buildArgs(_prompt: string): string[] {
    return ['-s', '--model', this.model, ...ISOLATION_ARGS];
  }

  protected get installHint() { return 'reinstall the GitHub Copilot CLI (npm i -g @github/copilot) and sign in with `copilot`, or set YG_COPILOT_BIN'; }

  async isAvailable(): Promise<boolean> {
    const found = resolveCopilotBinary();
    if (found === null) {
      this.lastProbeFailure = copilotNotFoundReason();
      return false;
    }
    const probe = await probeBinary(found);
    this.lastProbeFailure = probe.ok ? '' : `${probe.detail} — ${this.installHint}`;
    return probe.ok;
  }

  async unavailableReason(): Promise<string> {
    return this.lastProbeFailure || copilotNotFoundReason();
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    if (!/^[A-Za-z0-9._:-]+$/.test(this.model)) {
      return {
        satisfied: false,
        reason: `copilot-cli model '${this.model}' is not a model name (letters, digits, '.', '_', ':' and '-' only) — name one your Copilot plan allows, e.g. auto`,
        errorSource: 'provider',
      };
    }
    if (resolveCopilotBinary() === null) {
      return {
        satisfied: false,
        reason: copilotNotFoundReason(),
        errorSource: 'provider',
      };
    }
    return super.verifyAspect(prompt);
  }
}

registerProvider('copilot-cli', (c) => new CopilotCliProvider({ model: c.model, timeout: c.timeout }));

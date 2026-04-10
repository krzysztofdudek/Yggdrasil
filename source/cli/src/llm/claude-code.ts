import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmProvider, AspectResponse, AspectVerifyParams } from './types.js';
import { debugWrite } from '../utils/debug-log.js';

const execFileAsync = promisify(execFile);

function buildAspectPrompt(params: AspectVerifyParams): string {
  const fileList = params.sourceFiles.map(f => `  <file path="${f}" />`).join('\n');
  const contextSection = params.nodeContext
    ? `  <context>\n${params.nodeContext}\n  </context>`
    : `  <context-command>yg context --node ${params.nodePath}</context-command>`;

  return `<role>
You verify whether source code satisfies an architectural aspect.
Read each source file and the aspect content, then check compliance.
</role>

<aspect id="${params.aspectId}">
  <content path="${params.aspectContentPath}" />
</aspect>

<node path="${params.nodePath}" type="${params.nodeType ?? 'unknown'}">
${contextSection}
</node>

<source-files>
${fileList}
</source-files>

<task>
Read every source file listed above. Read the aspect content file.
Check each rule in the aspect against the source code.
Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation with file:line references"}
</task>`;
}

export class ClaudeCodeProvider implements LlmProvider {
  readonly needsChunking = false;
  private model: string;

  constructor(config: { model: string }) {
    this.model = config.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['claude'], { timeout: 5000 });
      return true;
    } catch (err) {
      debugWrite(`[claude-code] isAvailable: ${(err as Error).message}`);
      return false;
    }
  }

  async getContextWindowSize(): Promise<number | undefined> {
    return undefined;
  }

  async verifyAspect(params: AspectVerifyParams): Promise<AspectResponse> {
    const prompt = buildAspectPrompt(params);
    return this.runClaude<AspectResponse>(prompt, { satisfied: false, reason: 'Reviewer unavailable' }, params.projectRoot);
  }

  private runClaude<T>(prompt: string, fallback: T, cwd?: string): Promise<T> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', this.model, '--print'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
        cwd,
        env: { ...process.env },
      });

      let stdout = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        debugWrite('[claude-code] timeout after 120s');
        child.kill('SIGTERM');
      }, 120_000);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('error', () => { clearTimeout(timer); debugWrite('[claude-code] spawn error'); resolve(fallback); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed || code !== 0) {
          if (!killed && code !== 0) debugWrite(`[claude-code] exit_code=${code}`);
          resolve(fallback);
          return;
        }
        resolve(ClaudeCodeProvider.parseResponse<T>(stdout, fallback));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  static parseResponse<T>(output: string, fallback: T): T {
    const trimmed = output.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch (err) { debugWrite(`[claude-code] direct JSON parse failed: ${(err as Error).message}`); }

    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch (err) { debugWrite(`[claude-code] fence JSON parse failed: ${(err as Error).message}`); }
    }

    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch (err) { debugWrite(`[claude-code] embedded JSON parse failed: ${(err as Error).message}`); }
    }

    debugWrite('[claude-code] json_parse_failed, using natural language fallback');
    const lower = trimmed.toLowerCase();
    if ('satisfied' in (fallback as Record<string, unknown>)) {
      const satisfied = lower.includes('satisfied') && !lower.includes('not satisfied');
      return { satisfied, reason: trimmed.slice(0, 200) } as unknown as T;
    }
    if ('current' in (fallback as Record<string, unknown>)) {
      const current = !lower.includes('stale') && !lower.includes('outdated');
      return { current, reason: trimmed.slice(0, 200) } as unknown as T;
    }

    return fallback;
  }
}

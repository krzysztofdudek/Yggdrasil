import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmProvider, AspectResponse, ArtifactResponse, AspectVerifyParams, ArtifactReviewParams } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import { ARTIFACT_GUIDANCE } from './artifact-guidance.js';

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

function buildArtifactPrompt(params: ArtifactReviewParams): string {
  const fileList = params.sourceFiles.map(f => `  <file path="${f}" />`).join('\n');
  const typeRulesSection = params.qualityProfile
    ? `\n  <type-rules type="${params.nodeType}">\n${params.qualityProfile}\n  </type-rules>\n`
    : '';
  const ruleInteraction = params.qualityProfile
    ? `\n  <rule-interaction>\nType-specific rules REFINE general rules — they do not override them.\nWhen a type rule says "output format IS the contract", it means the general\nrule "don't restate observable behavior" does NOT apply to output format\nfor this node type.\n  </rule-interaction>`
    : '';
  const contextSection = params.nodeContext
    ? `  <context>\n${params.nodeContext}\n  </context>`
    : params.nodePath
      ? `  <context-command>yg context --node ${params.nodePath}</context-command>`
      : '';
  const nodeSection = params.nodePath
    ? `\n<node path="${params.nodePath}" type="${params.nodeType ?? 'unknown'}">\n${contextSection}\n</node>\n`
    : '';

  return `<role>
You review whether a graph artifact is current and follows quality guidelines.
Read the source files, then evaluate the artifact against the rules.
</role>

<rules>
  <general-rules>
${ARTIFACT_GUIDANCE}
  </general-rules>
${typeRulesSection}${ruleInteraction}
</rules>
${nodeSection}
<review-target>
  <artifact name="${params.artifactName}">
${params.artifactContent}
  </artifact>
</review-target>

<source-files>
${fileList}
</source-files>

<task>
Read every source file listed above. Compare the artifact against them.
Apply both general and type-specific rules.

CURRENT = artifact captures knowledge source code cannot express, follows all rules.
STALE = artifact contradicts source, violates rules, or is missing knowledge it should capture.

Respond with EXACTLY this JSON, nothing else:
{"current": true|false, "reason": "explanation"}
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
    } catch {
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

  async reviewArtifact(params: ArtifactReviewParams): Promise<ArtifactResponse> {
    const prompt = buildArtifactPrompt(params);
    return this.runClaude<ArtifactResponse>(prompt, { current: false, reason: 'Reviewer unavailable' }, params.projectRoot);
  }

  private runClaude<T>(prompt: string, fallback: T, cwd?: string): Promise<T> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', this.model, '--print'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        cwd,
        env: { ...process.env },
      });

      let stdout = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        debugWrite('[claude-code] timeout after 60s');
        child.kill('SIGTERM');
      }, 60_000);

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
    } catch { /* not pure JSON */ }

    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch { /* not valid JSON in fence */ }
    }

    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch { /* not valid JSON */ }
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

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmProvider, AspectResponse, ArtifactResponse } from './types.js';
import { ARTIFACT_GUIDANCE } from './artifact-guidance.js';

const execFileAsync = promisify(execFile);

const ASPECT_PROMPT_TEMPLATE = `You are a code reviewer verifying whether source code satisfies architectural requirements.

ASPECT REQUIREMENTS:
{aspectContent}

SOURCE FILES:
{sourceCode}

Does this code satisfy the requirements described above? Respond with EXACTLY this JSON format, nothing else:
{"satisfied": true|false, "reason": "one sentence explanation"}`;

const ARTIFACT_PROMPT_TEMPLATE = `You review whether a graph artifact follows the quality guidelines.

${ARTIFACT_GUIDANCE}

Report STALE when:
- Artifact contradicts the source code (describes behavior the code does NOT have)
- Artifact violates the quality test (contains file inventories, pseudocode, config paraphrases, sibling listings, or internal helper signatures)
- Artifact is missing knowledge it should capture (identity, boundaries, decisions, contracts)

Report CURRENT when:
- Artifact captures knowledge the code cannot express and follows the quality test
- Artifact is a correct high-level summary — omitting implementation details is correct behavior

ARTIFACT ({artifactName}):
{artifactContent}

SOURCE CODE:
{sourceCode}

Does this artifact follow the quality guidelines?
Respond with EXACTLY this JSON, nothing else:
{"current": true|false, "reason": "one sentence"}`;

export class ClaudeCodeProvider implements LlmProvider {
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
    return undefined; // claude-code manages context internally
  }

  async verifyAspect(params: {
    aspectContent: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<AspectResponse> {
    const prompt = ASPECT_PROMPT_TEMPLATE
      .replace('{aspectContent}', params.aspectContent)
      .replace('{sourceCode}', params.sourceCode);

    return this.runClaude<AspectResponse>(prompt, { satisfied: false, reason: 'Reviewer unavailable' });
  }

  async reviewArtifact(params: {
    artifactContent: string;
    artifactName: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ArtifactResponse> {
    const prompt = ARTIFACT_PROMPT_TEMPLATE
      .replace('{artifactName}', params.artifactName)
      .replace('{artifactContent}', params.artifactContent)
      .replace('{sourceCode}', params.sourceCode);

    return this.runClaude<ArtifactResponse>(prompt, { current: false, reason: 'Reviewer unavailable' });
  }

  private runClaude<T>(prompt: string, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', this.model, '--print'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        env: { ...process.env },
      });

      let stdout = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, 60_000);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('error', () => { clearTimeout(timer); resolve(fallback); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed || code !== 0) { resolve(fallback); return; }
        resolve(ClaudeCodeProvider.parseResponse<T>(stdout, fallback));
      });

      // Write prompt to stdin and close
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  /** Parse JSON from claude output. Falls back to natural language extraction. */
  static parseResponse<T>(output: string, fallback: T): T {
    // Try direct JSON parse
    const trimmed = output.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch { /* not pure JSON */ }

    // Try extracting JSON from markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch { /* not valid JSON in fence */ }
    }

    // Try finding JSON object in output
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch { /* not valid JSON */ }
    }

    // Natural language fallback for aspect responses
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

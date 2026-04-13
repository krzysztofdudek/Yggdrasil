import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { installRulesForPlatform, PLATFORMS } from '../../../src/templates/platform.js';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-platform-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('installRulesForPlatform', () => {
  it('PLATFORMS includes all expected platforms', () => {
    expect(PLATFORMS).toContain('cursor');
    expect(PLATFORMS).toContain('claude-code');
    expect(PLATFORMS).toContain('copilot');
    expect(PLATFORMS).toContain('cline');
    expect(PLATFORMS).toContain('roocode');
    expect(PLATFORMS).toContain('codex');
    expect(PLATFORMS).toContain('windsurf');
    expect(PLATFORMS).toContain('aider');
    expect(PLATFORMS).toContain('gemini');
    expect(PLATFORMS).toContain('amp');
    expect(PLATFORMS).toContain('opencode');
    expect(PLATFORMS).toContain('generic');
  });

  it('cursor when empty: creates .cursor/rules/yggdrasil.mdc with frontmatter', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'cursor');
      expect(out).toBe(path.join(root, '.cursor', 'rules', 'yggdrasil.mdc'));
      expect(existsSync(out)).toBe(true);
      const content = readFileSync(out, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('description: Yggdrasil — continuous architecture enforcement');
      expect(content).toContain('alwaysApply: true');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('cline when empty: creates .clinerules/yggdrasil.md', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'cline');
      expect(out).toBe(path.join(root, '.clinerules', 'yggdrasil.md'));
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf-8')).toBe(AGENT_RULES_CONTENT);
    });
  });

  it('roocode when empty: creates .roo/rules/yggdrasil.md', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'roocode');
      expect(out).toBe(path.join(root, '.roo', 'rules', 'yggdrasil.md'));
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf-8')).toBe(AGENT_RULES_CONTENT);
    });
  });

  it('windsurf when empty: creates .windsurf/rules/yggdrasil.md', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'windsurf');
      expect(out).toBe(path.join(root, '.windsurf', 'rules', 'yggdrasil.md'));
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf-8')).toBe(AGENT_RULES_CONTENT);
    });
  });

  it('generic when empty: creates .yggdrasil/agent-rules.md', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'generic');
      expect(out).toBe(path.join(root, '.yggdrasil', 'agent-rules.md'));
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf-8')).toBe(AGENT_RULES_CONTENT);
    });
  });

  it('claude-code when empty: creates agent-rules.md and CLAUDE.md with @ import', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'claude-code');
      expect(out).toBe(path.join(root, '.yggdrasil', 'agent-rules.md'));
      expect(existsSync(out)).toBe(true);
      const claude = path.join(root, 'CLAUDE.md');
      expect(existsSync(claude)).toBe(true);
      expect(readFileSync(claude, 'utf-8')).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('claude-code when existing: appends @ import to user content', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(root, 'CLAUDE.md'), '# My project\n\nUse TypeScript.\n', 'utf-8');
      await installRulesForPlatform(root, 'claude-code');
      const content = readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('# My project');
      expect(content).toContain('Use TypeScript.');
      expect(content).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('claude-code when import present: does not duplicate', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(root, 'CLAUDE.md'), '@.yggdrasil/agent-rules.md\n', 'utf-8');
      await installRulesForPlatform(root, 'claude-code');
      const content = readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
      expect((content.match(/@\.yggdrasil\/agent-rules\.md/g) ?? []).length).toBe(1);
    });
  });

  it('gemini when empty: creates agent-rules.md and GEMINI.md with @ import', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'gemini');
      expect(out).toBe(path.join(root, '.yggdrasil', 'agent-rules.md'));
      const gemini = path.join(root, 'GEMINI.md');
      expect(existsSync(gemini)).toBe(true);
      expect(readFileSync(gemini, 'utf-8')).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('gemini when existing: appends @ import to user content', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(root, 'GEMINI.md'), 'Focus on tests.\n', 'utf-8');
      await installRulesForPlatform(root, 'gemini');
      const content = readFileSync(path.join(root, 'GEMINI.md'), 'utf-8');
      expect(content).toContain('Focus on tests.');
      expect(content).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('amp when empty: creates agent-rules.md and AGENTS.md with @ import', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'amp');
      expect(out).toBe(path.join(root, '.yggdrasil', 'agent-rules.md'));
      const agents = path.join(root, 'AGENTS.md');
      expect(existsSync(agents)).toBe(true);
      expect(readFileSync(agents, 'utf-8')).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('amp when existing: appends @ import to user content', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(root, 'AGENTS.md'), '## Project rules\n\nBe concise.\n', 'utf-8');
      await installRulesForPlatform(root, 'amp');
      const content = readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('## Project rules');
      expect(content).toContain('@.yggdrasil/agent-rules.md');
    });
  });

  it('copilot when empty: creates .github/copilot-instructions.md with markers', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'copilot');
      expect(out).toBe(path.join(root, '.github', 'copilot-instructions.md'));
      expect(existsSync(out)).toBe(true);
      const content = readFileSync(out, 'utf-8');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain('<!-- yggdrasil:end -->');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('copilot when existing: appends block to user content', async () => {
    await withTempDir(async (root) => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, '.github'), { recursive: true });
      await writeFile(
        path.join(root, '.github', 'copilot-instructions.md'),
        '## General\n\nWrite clean code.\n',
        'utf-8',
      );
      await installRulesForPlatform(root, 'copilot');
      const content = readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf-8');
      expect(content).toContain('## General');
      expect(content).toContain('Write clean code.');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('copilot when markers present: replaces content between markers', async () => {
    await withTempDir(async (root) => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, '.github'), { recursive: true });
      await writeFile(
        path.join(root, '.github', 'copilot-instructions.md'),
        '<!-- yggdrasil:start -->\nold content\n<!-- yggdrasil:end -->',
        'utf-8',
      );
      await installRulesForPlatform(root, 'copilot');
      const content = readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf-8');
      expect(content).toContain(AGENT_RULES_CONTENT);
      expect(content).not.toContain('old content');
    });
  });

  it('codex when empty: creates AGENTS.md with markers', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'codex');
      expect(out).toBe(path.join(root, 'AGENTS.md'));
      expect(existsSync(out)).toBe(true);
      const content = readFileSync(out, 'utf-8');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain('<!-- yggdrasil:end -->');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('codex when existing: appends block to user content', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        path.join(root, 'AGENTS.md'),
        '# Agent rules\n\nPrefer functional style.\n',
        'utf-8',
      );
      await installRulesForPlatform(root, 'codex');
      const content = readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('# Agent rules');
      expect(content).toContain('Prefer functional style.');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('opencode when empty: creates AGENTS.md with markers (same as codex)', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'opencode');
      expect(out).toBe(path.join(root, 'AGENTS.md'));
      expect(existsSync(out)).toBe(true);
      const content = readFileSync(out, 'utf-8');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain('<!-- yggdrasil:end -->');
      expect(content).toContain(AGENT_RULES_CONTENT);
    });
  });

  it('aider when empty: creates agent-rules.md and .aider.conf.yml with read entry', async () => {
    await withTempDir(async (root) => {
      const out = await installRulesForPlatform(root, 'aider');
      expect(out).toBe(path.join(root, '.yggdrasil', 'agent-rules.md'));
      const aider = path.join(root, '.aider.conf.yml');
      expect(existsSync(aider)).toBe(true);
      const content = readFileSync(aider, 'utf-8');
      expect(content).toContain('.yggdrasil/agent-rules.md');
      expect(content).toMatch(/read:\s*\n\s+-\s+\.yggdrasil\/agent-rules\.md/);
    });
  });

  it('aider when existing: appends read entry to existing list', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(root, '.aider.conf.yml'), 'read:\n  - docs/README.md\n', 'utf-8');
      await installRulesForPlatform(root, 'aider');
      const content = readFileSync(path.join(root, '.aider.conf.yml'), 'utf-8');
      expect(content).toContain('docs/README.md');
      expect(content).toContain('.yggdrasil/agent-rules.md');
    });
  });

  it('aider when entry present: does not duplicate', async () => {
    await withTempDir(async (root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        path.join(root, '.aider.conf.yml'),
        'read:\n  - .yggdrasil/agent-rules.md\n',
        'utf-8',
      );
      await installRulesForPlatform(root, 'aider');
      const content = readFileSync(path.join(root, '.aider.conf.yml'), 'utf-8');
      expect((content.match(/\.yggdrasil\/agent-rules\.md/g) ?? []).length).toBe(1);
    });
  });
});

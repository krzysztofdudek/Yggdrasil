import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installRules, YGGDRASIL_START, YGGDRASIL_END, DEPRECATED_PLATFORMS,
} from '../../../src/templates/platform.js';
import { digestBlockBody, ANCHOR_RE } from '../../../src/templates/digest.js';

const V = '9.9.9';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'yg-install-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const read = (p: string) => readFileSync(path.join(root, p), 'utf-8');
const write = (p: string, c: string) => {
  mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  writeFileSync(path.join(root, p), c, 'utf-8');
};

describe('installRules — fresh repo', () => {
  it('creates the three artifacts with a valid anchor', async () => {
    await installRules(root, V);
    expect(read('AGENTS.md')).toContain(YGGDRASIL_START);
    expect(read('AGENTS.md')).toMatch(ANCHOR_RE);
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(read('.clinerules/yggdrasil.md')).toBe(digestBlockBody(V));
  });

  // The staleness gate compares the installed block against exactly this
  // canonical string, so the byte-for-byte identity of the AGENTS.md block —
  // not merely "contains a marker" — is the load-bearing contract.
  it('writes the canonical digest body verbatim between the markers', async () => {
    await installRules(root, V);
    expect(read('AGENTS.md'))
      .toBe(`${YGGDRASIL_START}\n${digestBlockBody(V)}${YGGDRASIL_END}\n`);
  });

  it('is idempotent — second run changes zero bytes', async () => {
    await installRules(root, V);
    const snap = ['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md'].map(read);
    await installRules(root, V);
    expect(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md'].map(read)).toEqual(snap);
  });
});

describe('installRules — user-content preservation', () => {
  it('appends block to existing AGENTS.md, preserving user bytes and CRLF', async () => {
    write('AGENTS.md', '# My project\r\n\r\nHand-written.\r\n');
    await installRules(root, V);
    const out = read('AGENTS.md');
    expect(out.startsWith('# My project\r\n\r\nHand-written.\r\n')).toBe(true);
    expect(out).toContain(YGGDRASIL_START);
    // Block re-applied in the host file's EOL style:
    expect(out).toContain('yggdrasil:start -->\r\n');
  });

  it('adds @AGENTS.md line to existing CLAUDE.md without duplication', async () => {
    write('CLAUDE.md', '# Repo notes\n@AGENTS.md\n');
    await installRules(root, V);
    expect(read('CLAUDE.md').match(/@AGENTS\.md/g)).toHaveLength(1);
  });
});

describe('installRules — legacy sweep', () => {
  it('replaces the old marker block in place (block moved by user)', async () => {
    write('AGENTS.md', `intro\n\n${YGGDRASIL_START}\nOLD RULES 53K\n${YGGDRASIL_END}\n\noutro\n`);
    await installRules(root, V);
    const out = read('AGENTS.md');
    expect(out).not.toContain('OLD RULES 53K');
    expect(out.indexOf('intro')).toBeLessThan(out.indexOf(YGGDRASIL_START));
    expect(out.indexOf(YGGDRASIL_END)).toBeLessThan(out.indexOf('outro'));
  });

  it('collapses duplicated marker blocks to one', async () => {
    write('AGENTS.md',
      `${YGGDRASIL_START}\nA\n${YGGDRASIL_END}\nmiddle\n${YGGDRASIL_START}\nB\n${YGGDRASIL_END}\n`);
    await installRules(root, V);
    expect(read('AGENTS.md').match(/yggdrasil:start/g)).toHaveLength(1);
    expect(read('AGENTS.md')).toContain('middle');
  });

  it('removes the amp-style import line from AGENTS.md', async () => {
    write('AGENTS.md', 'intro\n@.yggdrasil/agent-rules.md\n');
    await installRules(root, V);
    expect(read('AGENTS.md')).not.toContain('@.yggdrasil/agent-rules.md');
  });

  it('swaps the old CLAUDE.md import for @AGENTS.md', async () => {
    write('CLAUDE.md', 'notes\n@.yggdrasil/agent-rules.md\n');
    await installRules(root, V);
    expect(read('CLAUDE.md')).not.toContain('@.yggdrasil/agent-rules.md');
    expect(read('CLAUDE.md').match(/@AGENTS\.md/g)).toHaveLength(1);
  });

  it('sweeps every whole-file legacy artifact and prunes empty dirs', async () => {
    write('.yggdrasil/agent-rules.md', 'old');
    write('.cursor/rules/yggdrasil.mdc', 'old');
    write('.windsurf/rules/yggdrasil.md', 'old');
    write('.roo/rules/yggdrasil.md', 'old');
    write('.codebuddy/rules/yggdrasil/RULE.mdc', 'old');
    await installRules(root, V);
    for (const p of [
      '.yggdrasil/agent-rules.md', '.cursor/rules/yggdrasil.mdc', '.cursor/rules', '.cursor',
      '.windsurf', '.roo', '.codebuddy',
    ]) expect(existsSync(path.join(root, p))).toBe(false);
  });

  it('GEMINI.md: only-ours → deleted; with user content → line removed only', async () => {
    write('GEMINI.md', '@.yggdrasil/agent-rules.md\n');
    await installRules(root, V);
    expect(existsSync(path.join(root, 'GEMINI.md'))).toBe(false);

    write('GEMINI.md', 'user notes\n@.yggdrasil/agent-rules.md\n');
    await installRules(root, V);
    expect(read('GEMINI.md')).toBe('user notes\n');
  });

  it('copilot-instructions: marker block removed; only-ours file deleted', async () => {
    write('.github/copilot-instructions.md', `${YGGDRASIL_START}\nold\n${YGGDRASIL_END}\n`);
    await installRules(root, V);
    expect(existsSync(path.join(root, '.github/copilot-instructions.md'))).toBe(false);

    write('.github/copilot-instructions.md', `user\n\n${YGGDRASIL_START}\nold\n${YGGDRASIL_END}\n`);
    await installRules(root, V);
    expect(read('.github/copilot-instructions.md')).toBe('user\n');
  });

  it('aider: removes only the marked read entry; drops read: key when emptied', async () => {
    write('.aider.conf.yml', 'model: gpt-4\nread:\n  - .yggdrasil/agent-rules.md  # added by yg init\n');
    await installRules(root, V);
    expect(read('.aider.conf.yml')).toBe('model: gpt-4\n');

    write('.aider.conf.yml', 'read:\n  - KEEP.md\n  - .yggdrasil/agent-rules.md  # added by yg init\n');
    await installRules(root, V);
    expect(read('.aider.conf.yml')).toBe('read:\n  - KEEP.md\n');
  });

  it('reuses an existing case-variant instead of creating a duplicate', async () => {
    write('Agents.md', 'user stuff\n');
    await installRules(root, V);
    expect(read('Agents.md')).toContain(YGGDRASIL_START);
    // Exactly ONE AGENTS-ish file exists afterwards, and it is the user's
    // spelling — no second file was created alongside it. (Holds on
    // case-sensitive and case-insensitive filesystems alike.)
    expect(readdirSync(root).filter((e) => /^agents\.md$/i.test(e))).toEqual(['Agents.md']);
  });

  it('points the CLAUDE.md import at the case-variant AGENTS file it wrote', async () => {
    write('Agents.md', 'user stuff\n');
    await installRules(root, V);
    // A hardcoded `@AGENTS.md` would resolve to nothing on a case-sensitive
    // filesystem — the agent would end up with no rules at all.
    expect(read('CLAUDE.md')).toBe('@Agents.md\n');
  });
});

// --- Additional edge cases not covered by the scenarios above ---------------

describe('installRules — additional edge cases', () => {
  it('aider: removes the marked entry when it sits in the middle of the read: list', async () => {
    write(
      '.aider.conf.yml',
      'read:\n  - KEEP1.md\n  - .yggdrasil/agent-rules.md  # added by yg init\n  - KEEP2.md\n',
    );
    await installRules(root, V);
    const content = read('.aider.conf.yml');
    expect(content).toBe('read:\n  - KEEP1.md\n  - KEEP2.md\n');
  });

  it('AGENTS.md that is only whitespace is treated as empty (no data loss risk)', async () => {
    write('AGENTS.md', '   \n\n  \n');
    await installRules(root, V);
    const out = read('AGENTS.md');
    expect(out).toContain(YGGDRASIL_START);
    expect(out).toMatch(ANCHOR_RE);
  });

  it('an orphaned start marker with no closing marker does not crash and gets a fresh block appended', async () => {
    write('AGENTS.md', `intro\n${YGGDRASIL_START}\norphan, never closed\n`);
    await installRules(root, V);
    const out = read('AGENTS.md');
    // Cannot safely locate the malformed block's end, so the sweep does not
    // attempt surgery on it — it appends a fresh canonical block instead,
    // leaving the orphan text untouched (never dropping user content).
    expect(out).toContain('orphan, never closed');
    expect(out.match(/yggdrasil:start/g)?.length).toBe(2);
    expect(out).toMatch(ANCHOR_RE);

    // Run 2 is where the danger lives: the file now DOES contain an end
    // marker (the appended block's), so a start..end match that begins at the
    // unpaired marker would swallow the user's orphan text. An unpaired
    // marker must never anchor surgery — the file is byte-stable from here.
    await installRules(root, V);
    const again = read('AGENTS.md');
    expect(again).toContain('intro');
    expect(again).toContain('orphan, never closed');
    expect(again).toBe(out);
  });

  it('a prose mention of the start marker above a real block is never swallowed', async () => {
    write(
      'AGENTS.md',
      `# Docs\n\nWe document the marker \`${YGGDRASIL_START}\` here.\n\nkeep me\n\n` +
        `${YGGDRASIL_START}\nOLD RULES 53K\n${YGGDRASIL_END}\n`,
    );
    await installRules(root, V);
    const out = read('AGENTS.md');
    // The block regex used to match from the FIRST start marker (the prose
    // mention) to the first end marker, destroying everything between.
    expect(out).toContain('We document the marker');
    expect(out).toContain('keep me');
    expect(out).not.toContain('OLD RULES 53K');
    expect(out).toMatch(ANCHOR_RE);

    await installRules(root, V);
    expect(read('AGENTS.md')).toBe(out);
  });

  it('a fenced code example of the block above a real one is left alone; only the real block is replaced', async () => {
    write(
      'AGENTS.md',
      '# Docs\n\nExample:\n\n```\n' +
        `${YGGDRASIL_START}\nEXAMPLE BODY\n${YGGDRASIL_END}\n` +
        '```\n\nkeep me\n\n' +
        `${YGGDRASIL_START}\nOLD RULES 53K\n${YGGDRASIL_END}\n`,
    );
    await installRules(root, V);
    const out = read('AGENTS.md');
    // The fenced illustration is untouched — its body survives byte-for-byte
    // inside the fence, and the fence is never mistaken for a duplicate.
    expect(out).toContain(
      '```\n<!-- yggdrasil:start -->\nEXAMPLE BODY\n<!-- yggdrasil:end -->\n```',
    );
    expect(out).toContain('keep me');
    // Only the real (unfenced) block below is replaced.
    expect(out).not.toContain('OLD RULES 53K');
    expect(out).toMatch(ANCHOR_RE);
    expect(out.match(/yggdrasil:start/g)?.length).toBe(2);

    await installRules(root, V);
    expect(read('AGENTS.md')).toBe(out);
  });

  it('a single-line prose mention of both markers together is never mistaken for a block', async () => {
    const content = 'Notes.\n\n' +
      `This tool writes between ${YGGDRASIL_START} and ${YGGDRASIL_END} in this file.\n\n` +
      'More notes.\n';
    write('AGENTS.md', content);
    await installRules(root, V);
    const out = read('AGENTS.md');
    expect(out).toContain(
      `This tool writes between ${YGGDRASIL_START} and ${YGGDRASIL_END} in this file.`,
    );
    expect(out).toContain('More notes.');
    expect(out).toMatch(ANCHOR_RE);

    await installRules(root, V);
    expect(read('AGENTS.md')).toBe(out);
  });

  it('aider: keeps the read: key when a comment sits between it and a surviving item', async () => {
    write(
      '.aider.conf.yml',
      'model: gpt-4\nread:\n  # project docs\n  - KEEP.md\n' +
        '  - .yggdrasil/agent-rules.md  # added by yg init\n',
    );
    await installRules(root, V);
    // Dropping the key here left indented list items at document level —
    // the file stopped parsing as YAML.
    expect(read('.aider.conf.yml'))
      .toBe('model: gpt-4\nread:\n  # project docs\n  - KEEP.md\n');
  });

  it('aider: keeps the read: key when a blank line separates it from a surviving item', async () => {
    write(
      '.aider.conf.yml',
      'read:\n\n  - KEEP.md\n  - .yggdrasil/agent-rules.md  # added by yg init\n',
    );
    await installRules(root, V);
    expect(read('.aider.conf.yml')).toBe('read:\n\n  - KEEP.md\n');
  });

  it('aider: keeps the read: key when the surviving item is at zero indentation', async () => {
    write(
      '.aider.conf.yml',
      'model: gpt-4\nread:\n- KEEP.md\n- .yggdrasil/agent-rules.md  # added by yg init\n',
    );
    await installRules(root, V);
    // A zero-indent block-sequence item under `read:` is valid YAML. Dropping
    // the key here left `- KEEP.md` dangling at document level.
    expect(read('.aider.conf.yml')).toBe('model: gpt-4\nread:\n- KEEP.md\n');
  });

  it('aider: never deletes a user line that merely CONTAINS our marker comment', async () => {
    write('.aider.conf.yml', 'model: gpt-4  # added by yg init\n');
    const report = await installRules(root, V);
    // Only an actual `read:` list item we wrote may be removed — never an
    // arbitrary line that happens to carry the same comment text.
    expect(read('.aider.conf.yml')).toBe('model: gpt-4  # added by yg init\n');
    expect(report.removed).not.toContain('.aider.conf.yml (read entry)');
  });

  it('aider: drops an emptied read: key but leaves the user comment and later keys', async () => {
    write(
      '.aider.conf.yml',
      'model: gpt-4\nread:\n  # project docs\n' +
        '  - .yggdrasil/agent-rules.md  # added by yg init\nother: 1\n',
    );
    await installRules(root, V);
    // No item survives → the key goes. The user's comment line stays (a
    // comment-only line is valid YAML at any indentation) and `other:` is
    // untouched.
    expect(read('.aider.conf.yml')).toBe('model: gpt-4\n  # project docs\nother: 1\n');
  });

  it('copilot: bytes outside the marker block survive the block removal', async () => {
    write(
      '.github/copilot-instructions.md',
      `\n# Notes\n\n\n\nSection A\n\n${YGGDRASIL_START}\nold\n${YGGDRASIL_END}\n\nTail\n`,
    );
    await installRules(root, V);
    // Only the seam left by the removed block collapses; the leading blank
    // line and the deliberate multi-blank separator are user bytes.
    expect(read('.github/copilot-instructions.md'))
      .toBe('\n# Notes\n\n\n\nSection A\n\nTail\n');
  });

  it('copilot: a file that only mentions the marker is left byte-exact and unreported', async () => {
    const content = `# Notes\n\nWe use ${YGGDRASIL_START} as our fence.\n`;
    write('.github/copilot-instructions.md', content);
    const report = await installRules(root, V);
    expect(read('.github/copilot-instructions.md')).toBe(content);
    expect(report.removed).not.toContain('.github/copilot-instructions.md (block)');
  });

  it('GEMINI.md: a substring mention is not our import — file untouched, nothing reported', async () => {
    const content = 'See @.yggdrasil/agent-rules.md for details\r\nmixed\nEOLs\n';
    write('GEMINI.md', content);
    const report = await installRules(root, V);
    // Entering on a substring match rewrote the file (normalizing its mixed
    // EOLs) and reported a removal that never happened — on every run.
    expect(read('GEMINI.md')).toBe(content);
    expect(report.removed).toEqual([]);
  });

  it('.clinerules: a CRLF checkout is not rewritten on every run', async () => {
    const crlf = digestBlockBody(V).replace(/\n/g, '\r\n');
    write('.clinerules/yggdrasil.md', crlf);
    const report = await installRules(root, V);
    expect(report.written).not.toContain('.clinerules/yggdrasil.md');
    expect(read('.clinerules/yggdrasil.md')).toBe(crlf);
  });

  it('running installRules three times in a row is stable after the first sweep', async () => {
    write('AGENTS.md', `intro\n\n${YGGDRASIL_START}\nOLD RULES 53K\n${YGGDRASIL_END}\n\noutro\n`);
    await installRules(root, V);
    const first = read('AGENTS.md');
    await installRules(root, V);
    const second = read('AGENTS.md');
    await installRules(root, V);
    const third = read('AGENTS.md');
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

// --- InstallReport + the deprecated-platform list --------------------------

// A repository that documents its own agent setup carries the very lines this
// installer writes, inside fenced examples. Treating an example as an installed
// artifact is not a cosmetic slip: the writer skips the file believing it done,
// and the staleness gate agrees — so the repo LOOKS installed and the agent gets
// no rules at all, with nothing anywhere to surface it.
describe('installRules — fenced examples are documentation, not installs', () => {
  it('adds a real import when the only @AGENTS.md sits inside a code fence', async () => {
    write('CLAUDE.md', '# Docs\n\nAdd this line:\n\n```md\n@AGENTS.md\n```\n\nDone.\n');
    await installRules(root, V);
    const out = read('CLAUDE.md');
    // The fenced example survives byte-for-byte...
    expect(out).toContain('```md\n@AGENTS.md\n```');
    // ...and a genuine, unfenced import line now exists.
    const live = out.split('\n').filter((l, i, all) => {
      const fencesBefore = all.slice(0, i).filter((x) => /^\s*```/.test(x.trim())).length;
      return l.trim() === '@AGENTS.md' && fencesBefore % 2 === 0;
    });
    expect(live).toHaveLength(1);
  });

  it('reports CLAUDE.md as written when only a fenced example was present', async () => {
    write('CLAUDE.md', '```md\n@AGENTS.md\n```\n');
    const report = await installRules(root, V);
    expect(report.written).toContain('CLAUDE.md');
  });

  it('does not delete a fenced example of the retired rules import', async () => {
    write('CLAUDE.md', 'Old setups used:\n\n```md\n@.yggdrasil/agent-rules.md\n```\n');
    await installRules(root, V);
    expect(read('CLAUDE.md')).toContain('```md\n@.yggdrasil/agent-rules.md\n```');
  });

  it('leaves a GEMINI.md holding only a fenced example of the retired import alone', async () => {
    write('GEMINI.md', '```md\n@.yggdrasil/agent-rules.md\n```\n');
    const report = await installRules(root, V);
    expect(existsSync(path.join(root, 'GEMINI.md'))).toBe(true);
    expect(report.removed).not.toContain('GEMINI.md');
    expect(report.removed).not.toContain('GEMINI.md (import line)');
  });

  it('still removes a real, unfenced legacy import alongside a fenced example', async () => {
    write('GEMINI.md', 'Docs:\n\n```md\n@.yggdrasil/agent-rules.md\n```\n\n@.yggdrasil/agent-rules.md\n');
    await installRules(root, V);
    const out = read('GEMINI.md');
    expect(out).toContain('```md\n@.yggdrasil/agent-rules.md\n```');
    expect(out.trimEnd().endsWith('```')).toBe(true);
  });
});

describe('installRules — line endings', () => {
  it('keeps a mostly-LF file on LF despite one stray CRLF', async () => {
    write('AGENTS.md', 'a\r\nb\nc\nd\n');
    await installRules(root, V);
    const out = read('AGENTS.md');
    const crlf = (out.match(/\r\n/g) ?? []).length;
    const lf = (out.match(/\n/g) ?? []).length - crlf;
    // One stray terminator used to convert the whole file: every line of the
    // result came back CRLF, so a one-line edit rewrote every line in the diff.
    expect(crlf).toBe(0);
    expect(lf).toBeGreaterThan(10);
  });

  it('keeps a mostly-CRLF file on CRLF despite one stray LF', async () => {
    write('AGENTS.md', 'a\r\nb\r\nc\r\nd\n');
    await installRules(root, V);
    const out = read('AGENTS.md');
    const crlf = (out.match(/\r\n/g) ?? []).length;
    expect((out.match(/\n/g) ?? []).length - crlf).toBe(0);
    expect(crlf).toBeGreaterThan(10);
  });
});

describe('installRules — aider read: key scoping', () => {
  it('leaves a user\'s own empty read: key alone when no entry of ours is under it', async () => {
    // Our entry is nowhere in this file — only the marker COMMENT, on a line
    // the user annotated themselves. The key-drop used to run over the whole
    // file as soon as that text appeared anywhere, taking the user's own empty
    // `read:` key with it.
    const original = 'read:\nmodel: gpt-4  # added by yg init\n';
    write('.aider.conf.yml', original);
    const report = await installRules(root, V);
    expect(read('.aider.conf.yml')).toBe(original);
    expect(report.removed).not.toContain('.aider.conf.yml (read entry)');
  });

  it('leaves an unrelated empty read: key alone while dropping the one that held our entry', async () => {
    write(
      '.aider.conf.yml',
      'nested:\n  read:\nread:\n  - .yggdrasil/agent-rules.md  # added by yg init\n',
    );
    await installRules(root, V);
    // The indented `read:` belongs to the user's own mapping and is untouched;
    // only the top-level key our entry sat under is dropped.
    expect(read('.aider.conf.yml')).toBe('nested:\n  read:\n');
  });

  it('still drops the read: key that actually held our entry', async () => {
    write('.aider.conf.yml', 'model: gpt-4\nread:\n  - .yggdrasil/agent-rules.md  # added by yg init\n');
    await installRules(root, V);
    expect(read('.aider.conf.yml')).toBe('model: gpt-4\n');
  });
});

describe('installRules — InstallReport', () => {
  it('reports the three written paths, in POSIX form, on a fresh repo', async () => {
    const report = await installRules(root, V);
    expect(report.written).toEqual(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md']);
    expect(report.removed).toEqual([]);
  });

  it('reports the managed artifacts even when nothing changed', async () => {
    await installRules(root, V);
    const report = await installRules(root, V);
    expect(report.written).toEqual([]);
    // `managed` is what a caller reasons ABOUT the artifacts from, so it must
    // not depend on whether this particular run rewrote a byte.
    expect(report.managed).toEqual(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md']);
  });

  it('reports the managed artifacts in the repo\'s own case spelling', async () => {
    write('Agents.md', 'user stuff\n');
    const report = await installRules(root, V);
    expect(report.managed).toEqual(['Agents.md', 'CLAUDE.md', '.clinerules/yggdrasil.md']);
  });

  it('reports nothing written on an unchanged second run', async () => {
    await installRules(root, V);
    const report = await installRules(root, V);
    expect(report.written).toEqual([]);
    expect(report.removed).toEqual([]);
  });

  it('reports every swept legacy artifact', async () => {
    write('.cursor/rules/yggdrasil.mdc', 'old');
    write('GEMINI.md', '@.yggdrasil/agent-rules.md\n');
    write('.github/copilot-instructions.md', `user\n\n${YGGDRASIL_START}\nold\n${YGGDRASIL_END}\n`);
    write('.aider.conf.yml', 'read:\n  - .yggdrasil/agent-rules.md  # added by yg init\n');
    const report = await installRules(root, V);
    expect(report.removed).toEqual([
      '.cursor/rules/yggdrasil.mdc',
      'GEMINI.md',
      '.github/copilot-instructions.md (block)',
      '.aider.conf.yml (read entry)',
    ]);
    expect(report.written).toEqual(['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md']);
  });
});

describe('DEPRECATED_PLATFORMS', () => {
  it('lists exactly the thirteen retired platform names, without duplicates', () => {
    expect([...DEPRECATED_PLATFORMS].sort()).toEqual([
      'aider', 'amp', 'claude-code', 'cline', 'codebuddy', 'codex', 'copilot',
      'cursor', 'gemini', 'generic', 'opencode', 'roocode', 'windsurf',
    ]);
    expect(new Set(DEPRECATED_PLATFORMS).size).toBe(DEPRECATED_PLATFORMS.length);
  });
});

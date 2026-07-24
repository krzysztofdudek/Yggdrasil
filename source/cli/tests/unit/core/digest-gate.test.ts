import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { checkDigestGate } from '../../../src/core/checks/digest-gate.js';

/**
 * checkDigestGate — the committed-digest staleness gate.
 *
 * A pure, read-only WARNING check comparing three committed artifacts (the
 * AGENTS.md digest block, .clinerules/yggdrasil.md, and the CLAUDE.md
 * `@AGENTS.md` import line) against the installed CLI's canonical digest hash.
 * It is computed ONLY from an INJECTED RulesArtifacts snapshot — core reads no
 * files itself. Four states collapse into ONE grouped warning:
 *   - missing    — no block / no file / no import line.
 *   - modified   — the body's hash disagrees with its own anchor (including an
 *                  anchor line that was deleted or mangled beyond recognition).
 *   - outdated   — the anchor's hash disagrees with the installed CLI's
 *                  canonical digest hash (the `cli=` version string itself is
 *                  informational and never compared).
 *   - duplicated — more than one digest block in AGENTS.md; the first is
 *                  authoritative and gets hashed.
 *
 * All comparisons are over LF-normalized text so a CRLF checkout never trips
 * the gate.
 */

const HASH = 'a'.repeat(64);
const anchor = (h: string) => `<!-- yggdrasil:digest cli=1.0.0 sha256=${h} -->`;
const START = '<!-- yggdrasil:start -->';
const END = '<!-- yggdrasil:end -->';

// Body whose LF sha256 is controlled in tests via the injected canonical hash:
// the gate recomputes sha256 of the body it finds locally (node:crypto), so
// cases are crafted around a REAL hash of the string 'BODY\n'.
const BODY = 'BODY\n';
const BODY_HASH = createHash('sha256').update(BODY, 'utf-8').digest('hex');

const goodAgents = `intro\n${START}\n${anchor(BODY_HASH)}\n${BODY}${END}\n`;
const goodCline = `${anchor(BODY_HASH)}\n${BODY}`;

const base = {
  agentsMd: goodAgents,
  claudeMd: '@AGENTS.md\n',
  clinerules: goodCline,
  canonicalDigestHash: BODY_HASH,
};

describe('checkDigestGate', () => {
  it('silent when every artifact is aligned with the canonical hash', () => {
    expect(checkDigestGate(base)).toHaveLength(0);
  });

  it('missing artifacts (AGENTS.md block + .clinerules file) collapse into one warning', () => {
    const issues = checkDigestGate({ ...base, agentsMd: null, clinerules: null });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].code).toBe('rules-digest-stale');
    expect(issues[0].rule).toBe('rules-digest-stale');
    // Repo-level finding: it is about three files at the repository root, so
    // it names NO node. A synthetic one made every node-shaped view report a
    // component that does not exist.
    expect(issues[0].nodePath).toBeUndefined();
    expect(issues[0].messageData.next).toBe('yg init --upgrade');
    expect(issues[0].messageData.what).toContain('missing');
  });

  it('modified: body hash mismatch vs its own anchor', () => {
    const tampered = goodAgents.replace('BODY', 'EVIL');
    expect(checkDigestGate({ ...base, agentsMd: tampered })[0].messageData.what)
      .toContain('modified');
  });

  it('outdated: anchor hash internally consistent but disagrees with canonical', () => {
    expect(checkDigestGate({ ...base, canonicalDigestHash: HASH })[0].messageData.what)
      .toContain('older');
  });

  it('anchor line deleted → modified, not missing', () => {
    const noAnchor = `${START}\n${BODY}${END}\n`;
    const issues = checkDigestGate({ ...base, agentsMd: noAnchor });
    expect(issues[0].messageData.what).toContain('modified');
    expect(issues[0].messageData.what).not.toContain('missing');
  });

  it('anchor line hand-mangled (bad hex length) → modified, not missing', () => {
    const mangled = goodAgents.replace(BODY_HASH, BODY_HASH.slice(0, 10));
    const issues = checkDigestGate({ ...base, agentsMd: mangled });
    expect(issues[0].messageData.what).toContain('modified');
  });

  it('duplicated blocks in AGENTS.md → warning mentions duplication; first block is hashed', () => {
    const dup = goodAgents + goodAgents;
    const issues = checkDigestGate({ ...base, agentsMd: dup });
    expect(issues[0].messageData.what).toContain('more than one');
  });

  it('duplicated AND the first block is stale → both findings appear', () => {
    const dup = goodAgents.replace('BODY', 'EVIL') + goodAgents;
    const issues = checkDigestGate({ ...base, agentsMd: dup });
    expect(issues[0].messageData.what).toContain('modified');
    expect(issues[0].messageData.what).toContain('more than one');
  });

  it('CLAUDE.md import missing → one warning', () => {
    expect(checkDigestGate({ ...base, claudeMd: 'other\n' })).toHaveLength(1);
  });

  it('CLAUDE.md import matches case-insensitively (e.g. a repo using Agents.md)', () => {
    expect(checkDigestGate({ ...base, claudeMd: '@Agents.md\n' })).toHaveLength(0);
  });

  it('CRLF checkout of an otherwise-aligned repo stays silent', () => {
    const crlf = {
      ...base,
      agentsMd: goodAgents.replace(/\n/g, '\r\n'),
      clinerules: goodCline.replace(/\n/g, '\r\n'),
      claudeMd: base.claudeMd.replace(/\n/g, '\r\n'),
    };
    expect(checkDigestGate(crlf)).toHaveLength(0);
  });

  it('the cli= version token is never compared — a version bump alone never stales an aligned digest', () => {
    const bumpedVersionAnchor = `<!-- yggdrasil:digest cli=9.9.9 sha256=${BODY_HASH} -->`;
    const agentsMd = `intro\n${START}\n${bumpedVersionAnchor}\n${BODY}${END}\n`;
    expect(checkDigestGate({ ...base, agentsMd })).toHaveLength(0);
  });

  it('.clinerules trailing whitespace differs from canonical body → modified (a real content diff, not a false positive)', () => {
    const clinerules = `${anchor(BODY_HASH)}\n${BODY}   \n`;
    const issues = checkDigestGate({ ...base, clinerules });
    expect(issues[0].messageData.what).toContain('modified');
  });

  // Regression: the gate must detect blocks with the SAME parser the installer
  // uses (utils/marker-block.ts). A fenced ``` example of the block is a quoted
  // illustration — realistic in any repo documenting its own tooling — and the
  // installer deliberately ignores it. A gate with its own `START\n...END`
  // regex counted the example as a second installed block (false "duplicated")
  // and, when the example came FIRST, hashed the example's body instead of the
  // real one (false "modified"). Both survived `yg init --upgrade`, so neither
  // warning could ever be cleared.
  it('a fenced example of the block BEFORE the real one is not a second install', () => {
    const fenced =
      'Our docs illustrate the installed block:\n\n' +
      '```markdown\n' +
      `${START}\n${anchor('0'.repeat(64))}\nEXAMPLE BODY\n${END}\n` +
      '```\n\n';
    expect(checkDigestGate({ ...base, agentsMd: fenced + goodAgents })).toHaveLength(0);
  });

  it('a fenced example of the block AFTER the real one is not a second install', () => {
    const fenced =
      '\nAppendix — what the block looks like:\n\n' +
      '```markdown\n' +
      `${START}\n${anchor('0'.repeat(64))}\nEXAMPLE BODY\n${END}\n` +
      '```\n';
    expect(checkDigestGate({ ...base, agentsMd: goodAgents + fenced })).toHaveLength(0);
  });

  // The import line gets the same fence treatment as the block, and for a
  // sharper reason: the installer skips a CLAUDE.md whose only `@AGENTS.md` is
  // a fenced example, so if the gate counted that example as an import, writer
  // and reader would AGREE on a falsehood — a repo that looks installed while
  // Claude Code silently gets no rules, with nothing to surface it.
  it('a fenced example of the import line is not an installed import', () => {
    const claudeMd = '# Docs\n\nAdd this line to CLAUDE.md:\n\n```md\n@AGENTS.md\n```\n';
    const issues = checkDigestGate({ ...base, claudeMd });
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain('CLAUDE.md @AGENTS.md import is missing');
  });

  it('a real import alongside a fenced example is still recognized', () => {
    const claudeMd = '```md\n@AGENTS.md\n```\n\n@AGENTS.md\n';
    expect(checkDigestGate({ ...base, claudeMd })).toHaveLength(0);
  });

  it('unrelated marker-looking prose elsewhere in AGENTS.md never fools the gate', () => {
    const agentsMd =
      `Note: our internal wiki once used a fake marker like ` +
      `"<!-- yggdrasil:digest cli=0.0.0 sha256=${'f'.repeat(64)} -->" as an example.\n` +
      goodAgents;
    expect(checkDigestGate({ ...base, agentsMd })).toHaveLength(0);
  });
});

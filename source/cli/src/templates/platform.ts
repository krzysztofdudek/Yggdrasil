import { readFile, writeFile, mkdir, unlink, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { digestBlockBody } from './digest.js';
import { toPosixPath } from '../utils/posix.js';
import {
  YGGDRASIL_START, YGGDRASIL_END, findMarkerBlockRanges, unfencedLineIndices,
  type MarkerBlockRange,
} from '../utils/marker-block.js';
import { AGENTS_FILENAME, CLAUDE_FILENAME, CLINERULES_DIR, CLINERULES_FILENAME } from '../utils/rules-artifact-names.js';

// The marker constants and the block scanner live in utils/marker-block.ts so
// that the committed-digest gate (an `engine` module, which may not import a
// `template` one) judges blocks with the EXACT parser that writes them. They
// are re-exported here because this module is their historical public home.
export { YGGDRASIL_START, YGGDRASIL_END };
const LEGACY_IMPORT_LINE = '@.yggdrasil/agent-rules.md';
const AIDER_MARKER = '# added by yg init';
/** The exact aider `read:` list item a retired installer wrote — a hyphen
 *  list item (any indentation) whose value is the legacy rules path, tagged
 *  with our marker comment. Matching this precisely — not merely "the line
 *  contains the marker text" — keeps the sweep from deleting a user's own
 *  line that happens to carry the same comment string (e.g. a `model:` key
 *  the user personally annotated `# added by yg init`). */
const AIDER_ENTRY_RE = /^\s*-\s*\.yggdrasil\/agent-rules\.md\s*#\s*added by yg init\s*$/;

/** Old platform names — accepted by `yg init --platform` with a deprecation notice. */
export const DEPRECATED_PLATFORMS = [
  'cursor', 'claude-code', 'copilot', 'cline', 'roocode', 'codex', 'windsurf',
  'aider', 'gemini', 'amp', 'opencode', 'codebuddy', 'generic',
];

export interface InstallReport {
  written: string[];
  removed: string[];
  /**
   * Repo-relative POSIX paths of the artifacts this install OWNS, reported on
   * every run whether or not they changed — unlike `written`, which is empty on
   * a no-op re-run. Callers that need to say something ABOUT the artifacts (for
   * example: this project's coverage settings would report them as unmapped)
   * must not have that depend on whether this particular run rewrote a byte.
   * Case-accurate: an `Agents.md` repo gets its own spelling here, not the
   * canonical one.
   */
  managed: string[];
}

// --- small helpers -------------------------------------------------------

async function readIfExists(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf-8'); } catch { return null; }
}

/**
 * The dominant EOL of existing content — the one used by MOST of its line
 * terminators; LF on a tie, and for empty/absent content.
 *
 * Majority, not "any CRLF present": a file that is overwhelmingly LF but
 * carries a single stray CRLF (a pasted snippet, a merge artifact) used to be
 * classified CRLF, and since the write re-terminates every line, one stray
 * terminator converted the WHOLE file — a 4-line file with one CRLF came back
 * with 41 CRLF terminators and no LF. Whichever ending the file mostly uses is
 * the one it keeps.
 */
function eolOf(content: string | null): '\n' | '\r\n' {
  if (!content) return '\n';
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Re-apply a target EOL to LF-normalized text. */
function withEol(lfText: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? lfText : lfText.replace(/\n/g, '\r\n');
}

const norm = (s: string) => s.replace(/\r\n/g, '\n');

/**
 * Case-variant aware resolve: reuse an existing `Agents.md` etc.
 *
 * Exported because the committed-digest gate's CLI boundary must READ exactly
 * the files this installer WRITES. On a case-sensitive filesystem a repo whose
 * file is `Agents.md` gets its block written there (and an `@Agents.md` import
 * line), so a reader hardcoding `AGENTS.md` would see a correctly-installed
 * repo as having no digest block at all — a warning `yg init --upgrade` could
 * never clear. One resolver, used by both sides, makes that impossible.
 */
export async function resolveCaseVariant(root: string, name: string): Promise<string> {
  try {
    const entries = await readdir(root);
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    return path.join(root, hit ?? name);
  } catch {
    return path.join(root, name);
  }
}

/** Remove now-empty parent dirs up to (not including) root. */
async function pruneEmptyDirs(root: string, from: string): Promise<void> {
  let dir = path.dirname(from);
  // Separator-agnostic containment check (no path.sep literal): dir is a strict
  // descendant of root iff their relative path is non-empty, doesn't escape via
  // '..', and isn't itself absolute (the latter can happen when the two paths
  // share no common root, e.g. different drive letters).
  //
  // The escape test is on the FIRST PATH SEGMENT, not a `startsWith('..')`
  // prefix: `path.relative` normalizes, so any `..` it emits is a leading whole
  // segment, while a plain prefix test also rejects a legitimate descendant
  // whose own directory name merely begins with two dots (`..cache`, `..v2`) —
  // that directory would be left behind instead of pruned.
  while (dir !== root) {
    const rel = path.relative(root, dir);
    if (rel === '' || rel.split(/[/\\]/)[0] === '..' || path.isAbsolute(rel)) return;
    try {
      const rest = await readdir(dir);
      if (rest.length > 0) return;
      await rmdir(dir);
    } catch { return; }
    dir = path.dirname(dir);
  }
}

/** Replace the first pair with `block` and drop any duplicates; bytes outside the pairs are untouched. */
function replaceFirstBlock(text: string, ranges: MarkerBlockRange[], block: string): string {
  let out = '';
  let prev = 0;
  ranges.forEach((r, i) => {
    out += text.slice(prev, r.from) + (i === 0 ? block : '');
    prev = r.to;
  });
  return out + text.slice(prev);
}

/** Index at which the run of trailing newlines (LF or CRLF) begins. */
function trailingEolStart(s: string): number {
  let i = s.length;
  while (i > 0 && s[i - 1] === '\n') i -= i > 1 && s[i - 2] === '\r' ? 2 : 1;
  return i;
}

/** Index just past the run of leading newlines (LF or CRLF). */
function leadingEolEnd(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === '\n' || (s[i] === '\r' && s[i + 1] === '\n'))) {
    i += s[i] === '\r' ? 2 : 1;
  }
  return i;
}

/**
 * Cut `ranges` out of `text`, collapsing ONLY the seam each cut leaves behind
 * (the newline run that used to surround the block) to a single blank line.
 * Every other byte — leading blank lines, deliberate multi-blank separators
 * elsewhere in the document — is preserved exactly.
 */
function cutBlocks(text: string, ranges: MarkerBlockRange[], eol: '\n' | '\r\n'): string {
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const before = out.slice(0, ranges[i].from);
    const after = out.slice(ranges[i].to);
    const left = before.slice(0, trailingEolStart(before));
    const right = after.slice(leadingEolEnd(after));
    const seam = left === '' ? '' : right === '' ? eol : `${eol}${eol}`;
    out = left + seam + right;
  }
  return out;
}

/** Line indices carrying exactly `line` as a standalone, non-fenced line of `lf`. */
function importLineIndices(lf: string, line: string): number[] {
  return unfencedLineIndices(lf, (trimmed) => trimmed === line);
}

/**
 * Drop the lines that ARE the legacy import — whole line, surrounding
 * whitespace tolerated, and outside any fenced code block. The fence exclusion
 * is what keeps a documented EXAMPLE of the retired import (a repo describing
 * its own agent setup) from being deleted as if it were a live directive.
 */
function stripLegacyImportLines(lf: string): string {
  const drop = new Set(importLineIndices(lf, LEGACY_IMPORT_LINE));
  return lf.split('\n').filter((_l, i) => !drop.has(i)).join('\n');
}

/** Is `lf` carrying the legacy import as a live LINE (not prose, not a fenced example)? */
function hasLegacyImportLine(lf: string): boolean {
  return importLineIndices(lf, LEGACY_IMPORT_LINE).length > 0;
}

/**
 * Scan the block under a `read:` key (lines from `from`) and report the two
 * facts the sweep needs about it.
 *
 * Comments and blank lines are neutral — scanned past, never mistaken for the
 * end of the block, and never a reason to keep the key alive. A block-sequence
 * item is valid YAML at ANY indentation, including zero (`read:\n- a.md\n` is
 * a legal sequence), so it counts as content regardless of indentation; any
 * other indented line (a nested continuation) also counts. The first
 * non-indented, non-list-item, non-comment, non-blank line is the next
 * top-level key and ends the block.
 *
 * - `ownsOurEntry` — the block holds the exact list item a retired installer
 *   wrote, so it is a block THIS sweep is editing. Only such a block may have
 *   its key dropped: the key-drop used to run over every `read:` key in the
 *   file as soon as our marker string appeared anywhere, which deleted a
 *   user's own unrelated empty `read:` key as collateral.
 * - `survives` — content OTHER than our own entries remains, so the key must
 *   stay. Dropping a key whose block still has surviving lines would leave
 *   those lines dangling at document level, i.e. invalid YAML.
 */
function scanReadBlock(lines: string[], from: number): { ownsOurEntry: boolean; survives: boolean } {
  let ownsOurEntry = false;
  let survives = false;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l) && !/^-(\s|$)/.test(l)) break;
    if (AIDER_ENTRY_RE.test(l)) ownsOurEntry = true;
    else survives = true;
  }
  return { ownsOurEntry, survives };
}

// --- main entry ----------------------------------------------------------

/**
 * Universal installer + legacy sweep. Root-only and idempotent. Content the
 * user wrote outside our markers and our own lines is preserved verbatim, and
 * a fenced (```) example of either is left alone — it is documentation, not an
 * installed artifact.
 *
 * ONE byte-level caveat, stated because the rest of this contract is literal:
 * a host file is read, edited as LF, and written back in its DOMINANT line
 * ending (see `eolOf`). A file that consistently uses one ending keeps it
 * exactly; a file with MIXED endings is normalized to whichever it uses most,
 * so the minority terminators change even though no line's text does. Files we
 * do not rewrite at all this run are never touched.
 *
 * Writes three artifacts (AGENTS.md digest block, CLAUDE.md `@AGENTS.md`
 * import, `.clinerules/yggdrasil.md`) and sweeps every artifact any of the
 * 13 retired per-platform installers ever wrote, so a repo that adopted
 * Yggdrasil under the old system ends up with only the new, universal
 * install after running this once.
 */
export async function installRules(projectRoot: string, cliVersion: string): Promise<InstallReport> {
  const written: string[] = [];
  const removed: string[] = [];
  const rel = (p: string) => toPosixPath(path.relative(projectRoot, p));

  // 1. AGENTS.md — digest block (replace old block(s) in place, else append).
  const agentsPath = await resolveCaseVariant(projectRoot, AGENTS_FILENAME);
  const agentsRaw = await readIfExists(agentsPath);
  const agentsEol = eolOf(agentsRaw);
  let agents = agentsRaw === null ? '' : norm(agentsRaw);
  agents = stripLegacyImportLines(agents);
  const block = `${YGGDRASIL_START}\n${digestBlockBody(cliVersion)}${YGGDRASIL_END}`;
  const agentsRanges = findMarkerBlockRanges(agents);
  if (agentsRanges.length > 0) {
    agents = replaceFirstBlock(agents, agentsRanges, block);
  } else {
    // No genuine pair — including the case of a leftover unpaired marker,
    // which is left exactly where it is rather than used to anchor surgery.
    agents = agents.trimEnd()
      ? `${agents.trimEnd()}\n\n${block}\n`
      : `${block}\n`;
  }
  const agentsOut = withEol(agents, agentsEol);
  if (agentsOut !== agentsRaw) { await writeFile(agentsPath, agentsOut, 'utf-8'); written.push(rel(agentsPath)); }

  // 2. CLAUDE.md — ensure a single import of the AGENTS file we actually
  // wrote (its case-variant spelling, not a hardcoded `@AGENTS.md`, which
  // would resolve to nothing on a case-sensitive filesystem); drop legacy import.
  const agentsImportLine = `@${path.basename(agentsPath)}`;
  const claudePath = await resolveCaseVariant(projectRoot, CLAUDE_FILENAME);
  const claudeRaw = await readIfExists(claudePath);
  const claudeEol = eolOf(claudeRaw);
  let claude = claudeRaw === null ? '' : norm(claudeRaw);
  claude = stripLegacyImportLines(claude);
  // Case-insensitive match (an `Agents.md` repo's `@Agents.md` import is the
  // same commitment), but only on lines that are OUTSIDE a fenced code block:
  // a repo documenting its own agent setup routinely shows `@AGENTS.md` inside
  // a ``` example, and counting that as an installed import left the file
  // untouched while the run reported success — a repo that LOOKS installed and
  // gives Claude Code no rules at all. The gate reads the import line through
  // the same scanner, so writer and reader agree on what counts.
  const wantedImport = agentsImportLine.toLowerCase();
  const importIdx = new Set(
    unfencedLineIndices(claude, (trimmed) => trimmed.toLowerCase() === wantedImport),
  );
  const hasImport = importIdx.size > 0;
  claude = claude.split('\n').map((l, i) => {
    if (!importIdx.has(i)) return l;
    // Re-spell a differently-cased import onto the real filename; leave an
    // already-correct line byte-exact (padding and all).
    return l.trim() === agentsImportLine ? l : agentsImportLine;
  }).join('\n');
  if (!hasImport) {
    claude = claude.trimEnd() ? `${claude.trimEnd()}\n${agentsImportLine}\n` : `${agentsImportLine}\n`;
  }
  const claudeOut = withEol(claude, claudeEol);
  if (claudeOut !== claudeRaw) { await writeFile(claudePath, claudeOut, 'utf-8'); written.push(rel(claudePath)); }

  // 3. .clinerules/yggdrasil.md — wholly ours, overwrite. Compared EOL-aware:
  // a CRLF checkout holds the same content and must not be rewritten (and
  // re-reported as written) on every run.
  const clinePath = path.join(projectRoot, CLINERULES_DIR, CLINERULES_FILENAME);
  const clineRaw = await readIfExists(clinePath);
  const clineOut = withEol(digestBlockBody(cliVersion), eolOf(clineRaw));
  if (clineRaw !== clineOut) {
    await mkdir(path.dirname(clinePath), { recursive: true });
    await writeFile(clinePath, clineOut, 'utf-8');
    written.push(rel(clinePath));
  }

  // 4. Legacy whole-file artifacts. Every one of these was, under the old
  // per-platform installers, always written by a full unconditional
  // writeFile() with no prior read — so no installer ever preserved user
  // edits to these paths either; they are wholly-generated by construction,
  // safe to remove outright.
  for (const p of [
    '.yggdrasil/agent-rules.md',
    '.cursor/rules/yggdrasil.mdc',
    '.windsurf/rules/yggdrasil.md',
    '.roo/rules/yggdrasil.md',
    '.codebuddy/rules/yggdrasil/RULE.mdc',
  ]) {
    const abs = path.join(projectRoot, ...p.split('/'));
    if (await readIfExists(abs) !== null) {
      await unlink(abs);
      removed.push(p);
      await pruneEmptyDirs(projectRoot, abs);
    }
  }

  // 5. GEMINI.md — remove legacy import; delete when only-ours remains. The
  // guard matches the strip's predicate exactly (a whole LINE, not a substring
  // of prose), so a file merely mentioning the path is never rewritten — a
  // rewrite would normalize its EOLs and report a removal that never happened.
  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const geminiRaw = await readIfExists(geminiPath);
  if (geminiRaw !== null && hasLegacyImportLine(norm(geminiRaw))) {
    const stripped = stripLegacyImportLines(norm(geminiRaw));
    if (stripped.trim() === '') { await unlink(geminiPath); removed.push('GEMINI.md'); }
    else {
      const geminiOut = withEol(stripped, eolOf(geminiRaw));
      if (geminiOut !== geminiRaw) {
        await writeFile(geminiPath, geminiOut, 'utf-8');
        removed.push('GEMINI.md (import line)');
      }
    }
  }

  // 6. copilot-instructions.md — remove our marker block; delete when only-ours.
  // Surgery runs on the RAW bytes and touches only the seam the removed block
  // leaves behind: everything else the user wrote stays byte-exact.
  const copilotPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  const copilotRaw = await readIfExists(copilotPath);
  const copilotRanges = copilotRaw === null ? [] : findMarkerBlockRanges(copilotRaw);
  if (copilotRaw !== null && copilotRanges.length > 0) {
    const cleaned = cutBlocks(copilotRaw, copilotRanges, eolOf(copilotRaw));
    if (cleaned.trim() === '') {
      await unlink(copilotPath); removed.push('.github/copilot-instructions.md');
      await pruneEmptyDirs(projectRoot, copilotPath);
    } else if (cleaned !== copilotRaw) {
      await writeFile(copilotPath, cleaned, 'utf-8');
      removed.push('.github/copilot-instructions.md (block)');
    }
  }

  // 7. .aider.conf.yml — comment-anchored line surgery, never a YAML round-trip.
  const aiderPath = path.join(projectRoot, '.aider.conf.yml');
  const aiderRaw = await readIfExists(aiderPath);
  if (aiderRaw !== null && aiderRaw.includes(AIDER_MARKER)) {
    // Only ever remove a line that IS the list item we wrote — never any
    // line that merely contains the marker comment (e.g. a user's own
    // top-level key personally annotated with the same text). Both decisions
    // (drop the entry, drop the now-empty key) are made in ONE pass over the
    // original lines, so the key-drop is scoped to the block our entry was
    // actually in: a `read:` key elsewhere in the file that the user left
    // empty is not ours to delete.
    const lines = norm(aiderRaw).split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (AIDER_ENTRY_RE.test(line)) continue;
      // Drop a `read:` key only when it held our entry and nothing else is left
      // under it. Deciding on the single next line dropped the key whenever a
      // comment or blank line followed it, orphaning the surviving items at
      // document level.
      if (/^read:\s*$/.test(line)) {
        const block = scanReadBlock(lines, i + 1);
        if (block.ownsOurEntry && !block.survives) continue;
      }
      out.push(line);
    }
    const aiderOut = withEol(out.join('\n'), eolOf(aiderRaw));
    if (aiderOut !== aiderRaw) {
      await writeFile(aiderPath, aiderOut, 'utf-8');
      removed.push('.aider.conf.yml (read entry)');
    }
  }

  return { written, removed, managed: [rel(agentsPath), rel(claudePath), rel(clinePath)] };
}

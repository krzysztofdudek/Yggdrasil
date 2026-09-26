import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { toPosixPath } from '../utils/posix.js';
import type { Artifact } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { hashFile } from './hash.js';
import { readFileOrDefault } from './read-or-default.js';
import { gitignoreStackFor, isIgnoredByStack, withLocalGitignore, type GitignoreEntry } from './repo-scanner.js';

export async function readArtifacts(
  dirPath: string,
  excludeFiles: string[] = ['yg-node.yaml'],
  includeFiles?: string[],
): Promise<Artifact[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[artifact-reader] readdir: ${(err as Error).message}`);
    return [];
  }
  const artifacts: Artifact[] = [];
  const includeSet = includeFiles && includeFiles.length > 0 ? new Set(includeFiles) : null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (excludeFiles.includes(entry.name)) continue;
    if (includeSet && !includeSet.has(entry.name)) continue;

    const filePath = path.join(dirPath, entry.name);
    const content = await readFile(filePath, 'utf-8');
    artifacts.push({ filename: entry.name, content });
  }

  // Sort by filename for deterministic output
  artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
  return artifacts;
}

/** A file Node can run as a module: what a rule's code can import. */
const CODE_FILE = /\.(?:mjs|cjs|js)$/;

/** The rule's own code files — where tracing what the rule's code imports starts. */
const RULE_CODE_FILES = ['check.mjs', 'companion.mjs'] as const;

/**
 * Directory names never walked for a rule's files: installed dependencies (a
 * bare-specifier import is outside what a rule directory can pin) and a git
 * checkout's own metadata.
 */
function skippedDirName(name: string): boolean {
  return name === 'node_modules' || name === '.git';
}

/**
 * Every relative module specifier a piece of JavaScript names: static
 * `import … from`, `export … from`, a bare `import './x'`, a dynamic
 * `import('./x')`, `require('./x')` and `new URL('./x', import.meta.url)` (the
 * usual way a module finds a file shipped beside it) — each by a literal
 * relative specifier; one built at run time is not seen. A plain text scan, so a
 * specifier inside a comment or a string counts too — that only ever adds a file
 * to the rule's hash, never leaves one out, and a specifier naming no file is
 * dropped when it is resolved.
 */
function relativeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"`])(\.{1,2}\/[^'"`\n]*)\1/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) out.push(m[2]);
  return out;
}

/** A regular file, not followed through a link (a link is some other check's finding). */
async function isRegularFile(abs: string): Promise<boolean> {
  try {
    return (await lstat(abs)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether every component of `rel` below `dirPath` exists under exactly that
 * spelling. A case-insensitive filesystem (macOS, Windows) opens `./Helper.mjs`
 * for a file on disk as `helper.mjs`, where a case-sensitive one (Linux, most CI)
 * finds nothing: accepting the loose spelling would fold the file on one machine
 * and not the other, so the rule's hash would differ by operating system. Only
 * the exact on-disk spelling counts, everywhere.
 */
async function exactSpelling(dirPath: string, rel: string): Promise<boolean> {
  let current = dirPath;
  for (const part of rel.split('/')) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

/** Where a relative specifier leads inside the rule directory. */
type Resolved = { kind: 'file'; rel: string } | { kind: 'link'; rel: string } | null;

/**
 * The file a relative specifier in `fromRel` names, as a POSIX path relative to
 * the rule directory, or null when it names nothing there: a file outside the
 * directory, one under `node_modules`, or no file under its exact spelling. The
 * exact name is tried first, then the extensions and directory index files
 * CommonJS resolution also tries.
 *
 * A candidate whose path runs through a symbolic link is never followed: it is
 * returned as a link, the first linked component named, and the rule is refused
 * for it exactly as for a linked helper beside `check.mjs`. Following it would
 * fold a file from wherever the link points — outside the repository, different
 * on every machine, possibly unreadable — into the rule's hash.
 */
async function resolveInRuleDir(dirPath: string, fromRel: string, spec: string): Promise<Resolved> {
  const base = path.resolve(path.dirname(path.join(dirPath, fromRel)), spec.split(/[?#]/)[0]);
  const candidates = [
    base,
    ...['.mjs', '.js', '.cjs'].map((ext) => `${base}${ext}`),
    ...['index.mjs', 'index.js', 'index.cjs'].map((f) => path.join(base, f)),
  ];
  for (const abs of candidates) {
    const rel = toPosixPath(path.relative(dirPath, abs));
    if (rel === '' || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
    if (rel.split('/').some(skippedDirName)) return null;
    const linked = symlinkOnPath(dirPath, rel);
    if (linked !== null) return (await exactSpelling(dirPath, linked)) ? { kind: 'link', rel: linked } : null;
    if ((await isRegularFile(abs)) && (await exactSpelling(dirPath, rel))) return { kind: 'file', rel };
  }
  return null;
}

/** The support files of a rule, and the symbolic links its code would reach through. */
export interface SupportFiles {
  /** `[posix path relative to the rule directory, sha256]`, sorted. */
  files: Array<[string, string]>;
  /** Linked paths the rule's code names, relative to the rule directory, sorted — a refusal, never followed. */
  linked: string[];
}

/**
 * Every file in a rule's directory that the rule's code can reach besides its
 * own rule files, hashed — plus every symbolic link the rule's code names.
 *
 * A `check.mjs` (or a `companion.mjs`) may import a helper module beside it, or
 * read a table shipped with it. Those bytes decide the verdict exactly as the
 * rule file's own do, so they are verdict inputs too: without them, an update
 * that changed only a helper kept a stale pass on every warm cache.
 *
 * Three ways a file becomes part of the rule:
 *
 * 1. Any file in the directory, at any depth — except what describes or tunes
 *    the rule rather than runs (`exclude`, top level only: the rule definition,
 *    the rule files already hashed on their own, an adaptation, a log, a
 *    generator's provenance record), the `drills/` corpus it is measured
 *    against, and any subdirectory holding a `yg-aspect.yaml` of its own (a
 *    nested rule, with its own verdicts).
 * 2. A code file (`.mjs`, `.js`, `.cjs`) whose name, or a directory above it,
 *    starts with a dot, in the same region, and that the repository's
 *    `.gitignore` files do not ignore. Only code: a dot-named file is otherwise
 *    an editor's, a tool's or an operating system's (`.DS_Store`, a `.venv`, a
 *    `.cache`), differs from machine to machine, and would re-open verdicts
 *    nobody changed — but a dot-named module the rule imports runs exactly like
 *    any other.
 * 3. Any file the rule's code names by a literal relative specifier, wherever in
 *    the directory it sits — a helper kept under `drills/`, or in a nested rule's
 *    directory, is part of every rule that imports it — followed from module to
 *    module. Starting points: `check.mjs`, `companion.mjs` and every code file
 *    the first two ways found. A specifier built at run time is not seen.
 *
 * `node_modules` and `.git` are never walked or followed, and neither is a
 * symbolic link: one the rule's code names is returned in `linked` for the
 * caller to refuse. A directory that cannot be read yields nothing — the rule
 * then has no support files, which is the ordinary case. `projectRoot` locates
 * the `.gitignore` files that apply; without it only those inside the rule
 * directory do.
 */
export async function readSupportFileHashes(
  dirPath: string,
  exclude: readonly string[],
  projectRoot?: string,
): Promise<SupportFiles> {
  const hashed = new Map<string, string>();
  const linked = new Set<string>();

  async function walk(dirAbs: string, relPrefix: string, dotted: boolean, ignores: GitignoreEntry[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      debugWrite(`[artifact-reader] support files of ${dirAbs}: ${(err as Error).message}`);
      return;
    }
    if (relPrefix !== '' && entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) return;
    const here = await withLocalGitignore(dirAbs, ignores);
    for (const entry of entries) {
      if (skippedDirName(entry.name)) continue;
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      const abs = path.join(dirAbs, entry.name);
      const entryDotted = dotted || entry.name.startsWith('.');
      if (entryDotted && isIgnoredByStack(abs, here, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        if (relPrefix === '' && entry.name === 'drills') continue;
        await walk(abs, rel, entryDotted, here);
      } else if (entry.isFile()) {
        if (relPrefix === '' && exclude.includes(entry.name)) continue;
        if (entryDotted && !CODE_FILE.test(entry.name)) continue;
        hashed.set(rel, await hashFile(abs));
      }
    }
  }

  await walk(dirPath, '', false, projectRoot === undefined ? [] : await gitignoreStackFor(projectRoot, dirPath));

  // Follow what the rule's code imports. A file the rule's own hash already
  // covers (a top-level `exclude` entry) is followed but never folded twice.
  const queue: string[] = [...RULE_CODE_FILES, ...[...hashed.keys()].filter((rel) => CODE_FILE.test(rel))];
  const traced = new Set<string>();
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
    if (traced.has(rel)) continue;
    traced.add(rel);
    if (!(await isRegularFile(path.join(dirPath, rel)))) continue;
    const source = await readFileOrDefault(path.join(dirPath, rel), null, '[artifact-reader] rule code');
    if (source === null) continue;
    for (const spec of relativeSpecifiers(source)) {
      const target = await resolveInRuleDir(dirPath, rel, spec);
      if (target === null) continue;
      if (target.kind === 'link') {
        linked.add(target.rel);
        continue;
      }
      const ownRuleFile = !target.rel.includes('/') && exclude.includes(target.rel);
      if (!ownRuleFile && !hashed.has(target.rel)) {
        hashed.set(target.rel, await hashFile(path.join(dirPath, target.rel)));
      }
      if (CODE_FILE.test(target.rel) && !traced.has(target.rel)) queue.push(target.rel);
    }
  }

  return {
    files: [...hashed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    linked: [...linked].sort(),
  };
}

/**
 * Symbolic links in the files a rule is made of are refused, not followed.
 *
 * A rule's text and code are verdict inputs: what a reviewer is shown, what a
 * check runs, and what the verdict hash folds must be the same bytes. A symlink
 * breaks that in two ways. Readers disagree about it — one follows the link and
 * another skips it as "not a regular file" — so a rule ran its target while
 * hashing as nothing, or was reviewed as an empty rule while listed as
 * enforced. And a link can point outside the repository, so a clone, a CI
 * runner and a developer machine would each see different content under one
 * committed path, or a host file would reach a third-party reviewer.
 *
 * The same policy covers rule sources and the reference files a rule shows the
 * reviewer, and it matches the one mapped source files already follow: a path
 * that runs through a symlink is an error naming the link. A monorepo that
 * shares a rule copies it, or installs it as a package.
 */

/**
 * The first component of `rel` (a repository-relative path) that is a symbolic
 * link, as a repository-relative POSIX path, or null when none is. Components
 * that do not exist end the walk: a missing path is some other check's error.
 * Only components below `root` are examined — whatever the repository itself
 * sits under is not the repository's to answer for.
 */
export function symlinkOnPath(root: string, rel: string): string | null {
  const parts = toPosixPath(rel).split('/').filter((p) => p !== '' && p !== '.');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return parts.slice(0, i + 1).join('/');
  }
  return null;
}

/**
 * Every symbolic link among the files a rule directory contributes to its rule,
 * as POSIX paths relative to the directory, sorted: the top-level files
 * (yg-aspect.yaml, content.md, check.mjs, companion.mjs, an adaptation) and the
 * support files its code can reach, walked as the verdict's support-file hash
 * walks them (readSupportFileHashes) — under a dot-named entry only a linked code
 * file counts, since only code is hashed there; `node_modules`, `.git`, the
 * top-level `drills/` corpus and nested rule directories are not part of this
 * rule's walk and are not examined. A directory that cannot be read yields
 * nothing.
 */
export function ruleDirSymlinks(aspectDir: string): string[] {
  const found: string[] = [];
  const walk = (dirAbs: string, relPrefix: string, dotted: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      debugWrite(`[artifact-reader] ${dirAbs}: ${(err as Error).message}`);
      return;
    }
    if (relPrefix !== '' && entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) return;
    for (const entry of entries) {
      if (skippedDirName(entry.name)) continue;
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      const entryDotted = dotted || entry.name.startsWith('.');
      if (entry.isSymbolicLink()) {
        if (!entryDotted || CODE_FILE.test(entry.name)) found.push(rel);
      } else if (entry.isDirectory()) {
        if (relPrefix === '' && entry.name === 'drills') continue;
        walk(path.join(dirAbs, entry.name), rel, entryDotted);
      }
    }
  };
  walk(aspectDir, '', false);
  return found.sort();
}

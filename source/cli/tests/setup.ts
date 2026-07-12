import { beforeEach, afterEach, onTestFailed } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Defense-in-depth: git-fixture isolation boundary (runs once per worker) ──
// Test suites spawn throwaway `git init`/`add`/`commit` fixtures. If any such
// child `git` could reach THIS repository's real `.git`, a write op could reset
// the real index — and inside the pre-commit gate that yields a "green build that
// lies" (a partial staged set committed while the gate reported success). The
// per-fixture helper (tests/support/git-fixture.ts) pins each git op explicitly;
// this boundary is the belt-and-suspenders layer that also covers any suite the
// helper does not (yet) route through, present or future:
//   1. SCRUB inherited discovery vars from this worker's env, so every git child
//      spawned by any test starts from a clean env that cannot auto-locate the
//      real repo via a leaked GIT_DIR/GIT_INDEX_FILE/etc.
//   2. Set GIT_CEILING_DIRECTORIES to the repo root, so no git command started in
//      a repo SUBDIR can walk UP into the real `.git`. Legitimate real-repo reads
//      run with cwd = repo root, where `.git` is found before the ceiling stops
//      the ascent (verified against git's discovery semantics), so those keep
//      working; /tmp fixtures live on a different subtree and are unaffected.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// source/cli/tests → repo root is three levels up (tests → cli → source → root).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
for (const v of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]) {
  delete process.env[v];
}
process.env.GIT_CEILING_DIRECTORIES = REPO_ROOT;

let _capturedOut = '';
let _capturedErr = '';
let _origOut: typeof process.stdout.write;
let _origErr: typeof process.stderr.write;

beforeEach(() => {
  _capturedOut = '';
  _capturedErr = '';
  _origOut = process.stdout.write.bind(process.stdout);
  _origErr = process.stderr.write.bind(process.stderr);

  (process.stdout as NodeJS.WriteStream).write = (
    chunk: string | Buffer | Uint8Array,
  ): boolean => {
    _capturedOut += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  (process.stderr as NodeJS.WriteStream).write = (
    chunk: string | Buffer | Uint8Array,
  ): boolean => {
    _capturedErr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };

  onTestFailed(() => {
    if (_capturedOut) _origOut(`\n── captured stdout ──\n${_capturedOut}── end stdout ──\n`);
    if (_capturedErr) _origOut(`\n── captured stderr ──\n${_capturedErr}── end stderr ──\n`);
  });
});

afterEach(() => {
  (process.stdout as NodeJS.WriteStream).write = _origOut;
  (process.stderr as NodeJS.WriteStream).write = _origErr;
});

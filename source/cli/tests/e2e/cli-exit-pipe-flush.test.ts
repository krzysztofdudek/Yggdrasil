// =============================================================================
// CLI E2E — a long answer survives a slow pipe, whatever exit ends it.
//
// Node queues whatever a pipe cannot take at once (64 KiB on Linux) inside the
// process. A bare process.exit() ends the process with that queue unwritten, so
// a reader that is not draining the pipe at that instant — `yg … | head -c N`,
// an agent capturing output, `yg … | (sleep 1; cat)` — silently loses the tail
// of the report, exactly when it is longest. Every command exit goes through
// failAndExit or exitAfterFlush for that reason (the no-raw-process-exit rule
// keeps it so).
//
// The reader here sleeps before it reads, so when yg finishes writing the pipe
// is full and most of the report is still queued in the process. The bytes the
// slow reader gets must be the bytes the same run writes to a file, and the
// exit code must be the command's own in both cases.
//
// Two commands, two roles. `yg context --file` on a file governed by its type
// alone is one of the exits that used to be a bare process.exit(0): 6.1.0 as
// released delivers 64 KiB of its ~250 KiB answer to the sleeping reader, so
// this case is the regression test for that fix. `yg aspect-test --files` ends
// on exitAfterFlush(1) and guards the drain-then-exit helper itself on a
// non-zero exit, including a reader (`head -c`) that goes away early.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** Violations the rule reports on the one file — enough for several times the pipe's buffer. */
const VIOLATIONS = 4000;

/** A keyless project with one script rule that refuses its file many times over. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-exit-pipe-flush-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('src/a.ts', 'export const a = 1;\n');
  w('.yggdrasil/aspects/many/yg-aspect.yaml', 'name: Many\ndescription: "Refuses every file many times"\nerrs: exact\nreviewer:\n  type: deterministic\nstatus: enforced\nreview_by: 2027-01-01\n');
  w(
    '.yggdrasil/aspects/many/check.mjs',
    `export function check(ctx) {\n  const out = [];\n  for (const f of ctx.files) for (let i = 0; i < ${VIOLATIONS}; i++) out.push({ file: f.path, line: 1, message: 'violation ' + i + ' of a long refusal list that fills the pipe' });\n  return out;\n}\n`,
  );
  w('.yggdrasil/yg-architecture.yaml', 'node_types:\n  module:\n    description: A module\n    when:\n      path: "src/**"\n');
  w('.yggdrasil/model/svc/yg-node.yaml', 'name: Svc\ntype: module\ndescription: The svc\naspects: [many]\nmapping:\n  - src\n');
  return dir;
}

/** Run a shell pipeline; its last line of stdout is `<exit code of yg>`. */
function sh(script: string, cwd: string): { exit: number; stderr: string } {
  const r = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '0' } });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { exit: Number(lines[lines.length - 1]), stderr: r.stderr ?? '' };
}

/** Rules the file's type carries — enough for several times the pipe's buffer of context. */
const TYPE_RULES = 1500;

/** A keyless project whose one file is governed by its type alone, under many script rules. */
function typeCoveredProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-exit-pipe-flush-ctx-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('src/a.ts', 'export const a = 1;\n');
  const ids = Array.from({ length: TYPE_RULES }, (_, i) => `rule-with-a-long-descriptive-name-number-${i + 1}`);
  for (const id of ids) {
    w(`.yggdrasil/aspects/${id}/yg-aspect.yaml`, `name: ${id}\ndescription: "A rule of the module type"\nscope:\n  per: file\n`);
    w(`.yggdrasil/aspects/${id}/check.mjs`, 'export function check() { return []; }\n');
  }
  w('.yggdrasil/yg-architecture.yaml', `node_types:\n  module:\n    description: A module\n    when:\n      path: "src/**"\n    aspects:\n${ids.map((id) => `      - ${id}\n`).join('')}`);
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — a long answer read through a slow pipe', () => {
  it('yg context --file on a type-covered file: the slow reader gets every byte and the exit code is 0', () => {
    const dir = typeCoveredProject();
    try {
      const cmd = `node "${BIN_PATH}" context --file src/a.ts`;
      const direct = sh(`${cmd} > direct.txt 2>/dev/null; echo $?`, dir);
      const piped = sh(`${cmd} 2>/dev/null | (sleep 1; cat > piped.txt); echo \${PIPESTATUS[0]}`, dir);

      expect(direct.exit).toBe(0);
      expect(piped.exit).toBe(0);
      const want = readFileSync(path.join(dir, 'direct.txt'));
      const got = readFileSync(path.join(dir, 'piped.txt'));
      expect(want.length).toBeGreaterThan(3 * 64 * 1024);
      expect(got.length).toBe(want.length);
      expect(got.equals(want)).toBe(true);
      // The last rule of the answer is there, not only its byte count.
      expect(got.toString('utf-8')).toContain(`rule-with-a-long-descriptive-name-number-${TYPE_RULES} [`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('yg aspect-test --files: the slow reader gets every byte and the exit code is 1', () => {
    const dir = project();
    try {
      const cmd = `node "${BIN_PATH}" aspect-test --aspect many --files src/a.ts`;
      const direct = sh(`${cmd} > direct.txt 2>/dev/null; echo $?`, dir);
      const piped = sh(`${cmd} 2>/dev/null | (sleep 1; cat > piped.txt); echo \${PIPESTATUS[0]}`, dir);

      expect(direct.exit).toBe(1);
      expect(piped.exit).toBe(1);

      const want = readFileSync(path.join(dir, 'direct.txt'));
      const got = readFileSync(path.join(dir, 'piped.txt'));
      // Several times the 64 KiB a pipe holds, so the tail was queued in the process at exit.
      expect(want.length).toBeGreaterThan(4 * 64 * 1024);
      expect(got.length).toBe(want.length);
      expect(got.equals(want)).toBe(true);
      // The report's own last violation is there, not only its byte count.
      expect(got.toString('utf-8')).toContain(`violation ${VIOLATIONS - 1} of a long refusal list`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('`| head -c` takes exactly the bytes it asked for, and yg still exits 1', () => {
    const dir = project();
    try {
      const cmd = `node "${BIN_PATH}" aspect-test --aspect many --files src/a.ts`;
      const direct = sh(`${cmd} > direct.txt 2>/dev/null; echo $?`, dir);
      const limit = 200_000;
      const piped = sh(`${cmd} 2>/dev/null | (sleep 1; head -c ${limit} > head.txt); echo \${PIPESTATUS[0]}`, dir);

      expect(direct.exit).toBe(1);
      // The reader went away before yg was done; yg's code is still its own.
      expect(piped.exit).toBe(1);
      const want = readFileSync(path.join(dir, 'direct.txt')).subarray(0, limit);
      expect(readFileSync(path.join(dir, 'head.txt')).equals(want)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

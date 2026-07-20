import { describe, it, expect, vi, beforeEach } from 'vitest';

// getFileAtRef must return '' for a file that is simply absent at the ref, no
// matter what LANGUAGE / LC_MESSAGES the surrounding git binary speaks. git is
// gettext-localized upstream, so its "path ... does not exist" fatal message is
// translated under a non-English locale — a regression to classifying the
// failure by matching English stderr text would rethrow instead of returning ''.
//
// A localized git binary cannot be provisioned in this container (no git-l10n
// catalogs, no non-C locales installed), so the single git-subprocess seam is
// mocked to inject a NON-English fatal message and to answer the structural
// `git ls-tree` probe. No graph/fixture is fabricated — only the child-process
// boundary is stubbed, dispatching on the git subcommand.

const seam = vi.hoisted(() => ({
  run: (_file: string, _args: string[]) => Promise.resolve({ stdout: '', stderr: '' }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile: unknown = () => {
    throw new Error('callback form not used in this test');
  };
  // git-introspect promisifies execFile once at import; honoring the custom
  // promisify symbol makes `promisify(execFile)` resolve to our async seam.
  (execFile as Record<symbol, unknown>)[promisify.custom] = (file: string, args: string[]) =>
    seam.run(file, args);
  return { ...actual, execFile };
});

const { getFileAtRef } = await import('../../../src/utils/git-introspect.js');

beforeEach(() => {
  seam.run = () => Promise.resolve({ stdout: '', stderr: '' });
});

describe('getFileAtRef under a non-English git locale', () => {
  it("returns '' for an absent path even when git's fatal message is localized", async () => {
    seam.run = (_file, args) => {
      if (args[0] === 'show') {
        // German rendering of "fatal: path '…' does not exist in '…'".
        return Promise.reject(
          Object.assign(new Error('git show failed'), {
            stderr: "fatal: Pfad 'log.md' existiert nicht in 'HEAD'\n",
          }),
        );
      }
      if (args[0] === 'ls-tree') {
        // Valid ref, path genuinely absent from the tree -> empty listing.
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      throw new Error(`unexpected git subcommand: ${args.join(' ')}`);
    };

    await expect(getFileAtRef('/repo', 'HEAD', 'log.md')).resolves.toBe('');
  });

  it('rethrows a genuine failure (invalid ref) instead of masking it as empty', async () => {
    seam.run = (_file, args) => {
      if (args[0] === 'show') {
        return Promise.reject(
          Object.assign(new Error('git show failed'), {
            stderr: "fatal: ungültiger Objektname 'badref'\n",
          }),
        );
      }
      if (args[0] === 'ls-tree') {
        // Ref itself does not resolve -> ls-tree exits non-zero.
        return Promise.reject(Object.assign(new Error('ls-tree failed'), { code: 128 }));
      }
      throw new Error(`unexpected git subcommand: ${args.join(' ')}`);
    };

    await expect(getFileAtRef('/repo', 'badref', 'log.md')).rejects.toThrow(/git show failed/);
  });
});

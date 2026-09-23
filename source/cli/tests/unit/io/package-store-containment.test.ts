// =============================================================================
// Unit — the fence around every recursive delete the package store performs.
//
// `yg pack remove` and `update` delete an installed package's directory
// recursively. The directory comes from the install id in the committed record,
// and a record naming `../../..` once made `remove` delete the repository it ran
// in, `.git` included. The record parser refuses such an id; this pins the
// second, independent fence inside the store itself.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  installDirAbs,
  PackagePathEscapeError,
  removePackageFiles,
} from '../../../src/io/package-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-store-fence-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'acme', 'law', 'demo'), { recursive: true });
  writeFileSync(path.join(dir, 'keep.txt'), 'the repository itself\n', 'utf-8');
  return dir;
}

describe('the install directory an id may address', () => {
  it('resolves a well-formed id strictly inside aspects/packages/', () => {
    const dir = project();
    expect(installDirAbs(dir, 'acme/law/demo')).toBe(
      path.resolve(dir, '.yggdrasil', 'aspects', 'packages', 'acme', 'law', 'demo'),
    );
  });

  it.each(['../../..', '../../../victim', '/etc', '', 'acme/law', 'acme/law/x/demo', 'acme/../demo', 'acme/law/..', ' acme/law/demo'])(
    "refuses '%s'",
    (id) => {
      const dir = project();
      expect(() => installDirAbs(dir, id)).toThrow(PackagePathEscapeError);
    },
  );

  it('never deletes outside the packages area, whatever id it is handed', async () => {
    const dir = project();
    await expect(removePackageFiles(dir, '../../..')).rejects.toThrow(PackagePathEscapeError);
    expect(existsSync(path.join(dir, 'keep.txt'))).toBe(true);
    expect(existsSync(path.join(dir, '.yggdrasil'))).toBe(true);
  });
});

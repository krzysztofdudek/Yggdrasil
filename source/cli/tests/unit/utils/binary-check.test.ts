import { describe, it, expect } from 'vitest';
import { binaryAvailable } from '../../../src/utils/binary-check.js';
import { probeBinary } from '../../../src/utils/binary-check.js';

describe('binaryAvailable', () => {
  it('returns true for a binary that runs with --version', async () => {
    // `node` is guaranteed present in the test environment and supports
    // `--version` on every platform — exercises the clean-exit (available) path.
    expect(await binaryAvailable('node')).toBe(true);
  });

  it('returns false for a binary that is not installed', async () => {
    // A name that cannot resolve on PATH — exercises the catch (unavailable)
    // path. Crucially this is the case the old `which`-based probe got wrong on
    // Windows (where `which` itself is absent); the new probe reports it the
    // same way on every platform.
    expect(await binaryAvailable('yg-definitely-not-a-real-binary-zzz')).toBe(false);
  });
});

describe('probeBinary — keeps the cause', () => {
  it('says "not found on PATH" for a binary that is not installed', async () => {
    expect(await probeBinary('yg-definitely-not-a-real-binary-zzz')).toEqual({ ok: false, detail: "'yg-definitely-not-a-real-binary-zzz' was not found on PATH" });
  });

  it('is ok for a binary that runs', async () => {
    expect(await probeBinary('node')).toEqual({ ok: true });
  });
});

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';
import { readLock } from './support/read-lock.js';

// ---------------------------------------------------------------------------
// TIER-IDENTITY cascade E2E (verdict-lock model).
//
// An LLM pair's verdict hash folds in ONLY the resolved tier NAME — never its
// config. Changing which NAMED tier an aspect resolves to (renaming the tier, or
// repointing `reviewer.default`) changes that hash, so every using pair goes
// `unverified` and a re-fill (`yg check --approve`) is required. Editing a tier's
// CONFIG — consensus, model, endpoint, api_key, timeout — does NOT change the
// hash: every pair stays verified, no re-fill. The resolved reviewer config is the
// reviewer's private business; only the tier name is a judgment input, so a team
// can point the same named tier at a different model (or a local secrets overlay)
// without invalidating committed baselines.
//
// This suite proves that mechanic end-to-end against the real built binary.
//
// Hermetic design (no real model, no external network):
//   The `has-doc-comment` LLM aspect is enforced on the two `service` nodes.
//   We point its reviewer tier at an in-process mock reviewer (support/
//   mock-reviewer.ts) that speaks the Ollama wire protocol and always returns a
//   satisfied verdict. `yg check --approve` then records a real, fully-verified
//   lock entry whose hash tracks the aspect's resolved tier identity.
//   Mutating the tier config in the temp copy makes those pairs `unverified` in
//   the next `yg check` — and crucially `yg check` reads no reviewer (the
//   invalidation is deterministic), so the tier edit is observed without any LLM
//   call.
//
// Why a LIVE mock and not a dead endpoint: a reviewer INFRA failure now fails
// closed (#2) — an unreachable reviewer writes NO lock entry, so there would be
// nothing to invalidate against. A satisfied mock gives us a genuine green lock
// to perturb, which is what the tier-identity mechanic operates on.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint, used ONLY as an endpoint-EDIT target. Port 1 never
// has a listener; pointing the config there is a genuine tier change, and
// because `yg check` performs no reviewer call, the address being dead is
// irrelevant to the deterministic invalidation the test asserts on.
const DEAD_ENDPOINT_ALT = 'http://127.0.0.2:1';

const OK: () => ChatReply = () => ({ satisfied: true, reason: 'ok' });

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-tier-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const yggPath = (dir: string) => path.join(dir, '.yggdrasil');

/**
 * The recorded lock entry for one aspect/unit pair, serialized (or undefined).
 *
 * `has-doc-comment` is an LLM aspect, so its verdict lives in the committed
 * `yg-lock.nondeterministic.json` of the 5.1.0 triad. `readLock` merges the
 * three on-disk lock files into the unified shape, returning empty verdicts
 * when no lock has been written yet.
 */
function lockEntry(dir: string, aspectId: string, unitKey: string): string | undefined {
  const lock = readLock(yggPath(dir));
  const v = lock.verdicts[aspectId]?.[unitKey];
  return v === undefined ? undefined : JSON.stringify(v);
}

/** Repoint the reviewer endpoint at the live mock (rewrites the first `endpoint:`). */
function pointReviewer(dir: string, endpoint: string): void {
  const cfg = readFileSync(cfgPath(dir), 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${endpoint}"`,
  );
  writeFileSync(cfgPath(dir), cfg, 'utf-8');
}

/** Overwrite the whole config with a hand-authored variant. */
function writeConfig(dir: string, yaml: string): void {
  writeFileSync(cfgPath(dir), yaml, 'utf-8');
}

/** Read the temp config so a single field can be string-replaced in place. */
function patchConfig(dir: string, from: string | RegExp, to: string): void {
  const cfg = readFileSync(cfgPath(dir), 'utf-8').replace(from, to);
  writeFileSync(cfgPath(dir), cfg, 'utf-8');
}

const HAS_DOC = 'has-doc-comment';
const ORDERS = 'node:services/orders';
const PAYMENTS = 'node:services/payments';

/** Point the reviewer at the live mock, then fill the repo to a green lock. */
async function fillGreen(dir: string, endpoint: string): Promise<void> {
  pointReviewer(dir, endpoint);
  const r = await runAsync(['check', '--approve'], dir);
  expect(r.status).toBe(0);
  // Both service nodes hold an approved verdict for the enforced LLM aspect.
  expect(JSON.parse(lockEntry(dir, HAS_DOC, ORDERS)!).verdict).toBe('approved');
  expect(JSON.parse(lockEntry(dir, HAS_DOC, PAYMENTS)!).verdict).toBe('approved');
}

/** Assert both LLM pairs render as unverified in `yg check` (exit 1). */
function expectBothUnverified(all: string): void {
  // Grouped view: one `unverified` group for the aspect, with both nodes listed.
  expect(all).toContain('unverified (not yet reviewed)');
  expect(all).toContain(`aspect '${HAS_DOC}'`);
  expect(all).toContain('- services/orders');
  expect(all).toContain('- services/payments');
}

// Two-tier config (default = standard) used to exercise the default-flip
// scenario. BOTH tiers point at the same live mock endpoint, so the reviewer is
// reachable no matter which one resolves.
const twoTierConfig = (endpoint: string) => `version: "5.2.0"

quality:
  max_direct_relations: 10

reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${endpoint}"
    deep:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:1.5b"
        endpoint: "${endpoint}"
`;

describe.skipIf(!distExists)('CLI E2E — tier-NAME identity (only the resolved tier NAME re-verifies; config edits do not)', () => {
  // --- T0: the hermetic assumption itself ---

  it('T0: a satisfied-mock fill writes a lock that TRACKS the LLM aspect tier-identity', async () => {
    const dir = copyFixture('t0');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await fillGreen(dir, mock.endpoint);
      // A clean re-check is green — the recorded verdict holds.
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T1: scenario 1 — a consensus edit does NOT invalidate (config, not name) ---

  it('T1: editing the tier consensus (1→3) does NOT invalidate — config is not a verdict input', async () => {
    const dir = copyFixture('t1');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await fillGreen(dir, mock.endpoint);
      const callsBefore = mock.chatCount();

      // Mutate the tier config: consensus 1 → 3. The hash folds only the tier
      // NAME, so every using pair stays verified.
      patchConfig(dir, 'consensus: 1', 'consensus: 3');

      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('Filling 0 unverified pairs');
      expect(mock.chatCount() - callsBefore).toBe(0); // nothing re-reviewed

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T2: scenario 2 — editing a tier config field (model / endpoint) does NOT invalidate ---

  it('T2: editing the tier model does NOT invalidate — config is not a verdict input', async () => {
    const dir = copyFixture('t2-model');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await fillGreen(dir, mock.endpoint);
      const callsBefore = mock.chatCount();

      patchConfig(dir, 'qwen2.5-coder:0.5b', 'llama3.2:1b');

      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('Filling 0 unverified pairs');
      expect(mock.chatCount() - callsBefore).toBe(0);

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T2b: editing the tier endpoint does NOT invalidate — config is not a verdict input', async () => {
    const dir = copyFixture('t2-endpoint');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await fillGreen(dir, mock.endpoint);
      const callsBefore = mock.chatCount();

      // Repoint at a different address — a config change, not a name change.
      patchConfig(dir, mock.endpoint, DEAD_ENDPOINT_ALT);

      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('Filling 0 unverified pairs');
      expect(mock.chatCount() - callsBefore).toBe(0);

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T3: scenario 3 — rename the tier and repoint the default ---

  it('T3: renaming the tier and repointing the default invalidates every using pair', async () => {
    const dir = copyFixture('t3');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await fillGreen(dir, mock.endpoint);

      // Rename `standard` → `primary` and repoint reviewer.default. The tier
      // name is part of the identity, so this invalidates even though the config
      // body is byte-equivalent.
      writeConfig(
        dir,
        `version: "5.2.0"

quality:
  max_direct_relations: 10

reviewer:
  default: primary
  tiers:
    primary:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${mock.endpoint}"
`,
      );

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expectBothUnverified(check.all);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T4: scenario 4 — editing reviewer.default cascades to default-relying aspects ---

  it('T4: editing reviewer.default invalidates aspects relying on the default tier', async () => {
    const dir = copyFixture('t4');
    const mock = await startMockReviewer({ respond: OK });
    try {
      // Start with TWO tiers (default = standard). `has-doc-comment` pins no
      // tier, so it resolves the default. Both tiers point at the live mock.
      writeConfig(dir, twoTierConfig(mock.endpoint));
      // fillGreen() also calls pointReviewer(), which only rewrites the FIRST
      // endpoint match. Both tiers already point at the mock, so the reviewer
      // stays reachable regardless.
      await fillGreen(dir, mock.endpoint);

      // Flip the default standard → deep. The aspect's resolved tier changes
      // without touching the aspect itself.
      patchConfig(dir, 'default: standard', 'default: deep');

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expectBothUnverified(check.all);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T5: scenario 5 — api_key rotation is EXCLUDED from tier identity ---

  it('T5: rotating the tier api_key does NOT invalidate (api_key excluded from tier identity)', async () => {
    const dir = copyFixture('t5');
    const mock = await startMockReviewer({ respond: OK });
    try {
      // Author a config that carries an api_key, pointing at the live mock.
      writeConfig(
        dir,
        `version: "5.2.0"

quality:
  max_direct_relations: 10

reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${mock.endpoint}"
        api_key: "secret-old-key-aaaa"
`,
      );
      await fillGreen(dir, mock.endpoint);

      const callsBefore = mock.chatCount();

      // Rotate ONLY the api_key. The tier-identity hash omits api_key, so the
      // hash is unchanged → no pair is invalidated.
      patchConfig(dir, 'secret-old-key-aaaa', 'secret-NEW-key-bbbb');

      // The next fill finds NOTHING to do — every pair still holds a valid verdict.
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('Filling 0 unverified pairs');
      expect(mock.chatCount() - callsBefore).toBe(0); // zero reviewer calls

      // And a plain check stays green.
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T6: scenario 6 — timeout is EXCLUDED from tier identity ---

  it('T6: editing the tier timeout (transport knob) does NOT invalidate', async () => {
    const dir = copyFixture('t6');
    const mock = await startMockReviewer({ respond: OK });
    try {
      // Author a config whose tier config carries a timeout, pointing at the mock.
      writeConfig(
        dir,
        `version: "5.2.0"

quality:
  max_direct_relations: 10

reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${mock.endpoint}"
        timeout: 30000
`,
      );
      await fillGreen(dir, mock.endpoint);

      const callsBefore = mock.chatCount();

      // Change ONLY the timeout. It is stripped from the tier-identity hash, so
      // no pair is invalidated.
      patchConfig(dir, 'timeout: 30000', 'timeout: 99000');

      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('Filling 0 unverified pairs');
      expect(mock.chatCount() - callsBefore).toBe(0);

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

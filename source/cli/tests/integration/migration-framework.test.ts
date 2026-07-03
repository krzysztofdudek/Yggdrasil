import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVersionUpgrade } from '../../src/core/migrator-runner.js';
import { detectVersion } from '../../src/core/migrator.js';
import type { Migration } from '../../src/core/migrator.js';

// ── Framework-level integration tests ──────────────────────────
//
// These tests exercise the migration runner contract — incremental
// per-migration version bumping, persistence between steps, and the
// chain-stop semantics on a bumpVersion:false signal. They use mock
// Migration objects so the framework behaviour is isolated from any
// specific migration's side-effects on disk.
//
// Real-migration end-to-end tests live in migration-4.2-to-4.3.test.ts
// and migration-4.3-to-5.0.test.ts.

function seedRepoAtVersion(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-mig-fw-'));
  const yggRoot = join(root, '.yggdrasil');
  mkdirSync(yggRoot, { recursive: true });
  writeFileSync(join(yggRoot, 'yg-config.yaml'), `version: "${version}"\n`);
  return yggRoot;
}

function readVersion(yggRoot: string): string | null {
  if (!existsSync(join(yggRoot, 'yg-config.yaml'))) return null;
  const content = readFileSync(join(yggRoot, 'yg-config.yaml'), 'utf-8');
  const match = content.match(/^version:\s*["']?([^"'\n]+)["']?\s*$/m);
  return match ? match[1].trim() : null;
}

function mockMigration(to: string, opts: {
  description?: string;
  actions?: string[];
  warnings?: string[];
  bumpVersion?: boolean;
  onRun?: (yggRoot: string) => void;
} = {}): Migration {
  return {
    to,
    description: opts.description ?? `Mock migration to ${to}`,
    run: async (yggRoot: string) => {
      opts.onRun?.(yggRoot);
      return {
        actions: opts.actions ?? [`mock migration to ${to} ran`],
        warnings: opts.warnings ?? [],
        bumpVersion: opts.bumpVersion,
      };
    },
  };
}

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function track<T extends string>(yggRoot: T): T {
  dirsToCleanup.push(yggRoot.replace(/[/\\]\.yggdrasil$/, ''));
  return yggRoot;
}

describe('migration runner — incremental version bump contract', () => {
  it('reads the current version from yg-config.yaml — no fromVersion parameter is required', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const ran: string[] = [];
    const migrations = [
      mockMigration('4.3.0', { onRun: () => ran.push('4.3.0') }),
    ];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(result.fromVersion).toBe('4.0.0');
    expect(ran).toEqual(['4.3.0']);
  });

  it('reports landedVersion as the last successfully completed migration target', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const migrations = [
      mockMigration('4.3.0'),
      mockMigration('5.0.0'),
    ];
    const result = await runVersionUpgrade({ yggRoot, migrations });
    expect(result.landedVersion).toBe('5.0.0');
  });

  it('advances version exactly one step per successful migration (4.0.0 → 4.3.0 → 5.0.0)', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const observedAtRun: string[] = [];
    const migrations = [
      mockMigration('5.0.0', {
        onRun: (root) => observedAtRun.push(`5.0.0 saw ${readVersion(root)}`),
      }),
      mockMigration('4.3.0', {
        onRun: (root) => observedAtRun.push(`4.3.0 saw ${readVersion(root)}`),
      }),
    ];

    await runVersionUpgrade({ yggRoot, migrations });

    // Migrations execute in semver order regardless of input order.
    // The second migration must observe the intermediate 4.3.0 already
    // persisted in the config (proving the incremental bump contract).
    expect(observedAtRun).toEqual([
      '4.3.0 saw 4.0.0',
      '5.0.0 saw 4.3.0',
    ]);
    expect(readVersion(yggRoot)).toBe('5.0.0');
  });

  it('persists the intermediate version on disk before invoking the next migration', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    let versionWhenSecondRan: string | null = null;
    const migrations = [
      mockMigration('4.3.0'),
      mockMigration('5.0.0', {
        onRun: (root) => { versionWhenSecondRan = readVersion(root); },
      }),
    ];

    await runVersionUpgrade({ yggRoot, migrations });

    expect(versionWhenSecondRan).toBe('4.3.0');
  });

  it('STOPS the chain when a migration returns bumpVersion: false — version stays at last good step', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const ran: string[] = [];
    const migrations = [
      mockMigration('4.3.0', { onRun: () => ran.push('4.3.0') }),
      mockMigration('5.0.0', {
        warnings: ['something is wrong'],
        bumpVersion: false,
        onRun: () => ran.push('5.0.0'),
      }),
      mockMigration('6.0.0', { onRun: () => ran.push('6.0.0') }),
    ];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    // The aborting migration runs (its warning is emitted), but the
    // later migration does NOT run. Version on disk stays at the last
    // successfully completed step (4.3.0).
    expect(ran).toEqual(['4.3.0', '5.0.0']);
    expect(result.migrationWarnings).toContain('something is wrong');
    expect(readVersion(yggRoot)).toBe('4.3.0');
    expect(result.landedVersion).toBe('4.3.0');
  });

  it('STOPS without any bump when the FIRST migration returns bumpVersion: false', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const migrations = [
      mockMigration('4.3.0', {
        warnings: ['cannot continue'],
        bumpVersion: false,
      }),
      mockMigration('5.0.0'),
    ];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(readVersion(yggRoot)).toBe('4.0.0');
    expect(result.landedVersion).toBe('4.0.0');
    expect(result.migrationWarnings).toContain('cannot continue');
  });

  it('runs no migrations and changes nothing when current version is already at the latest target', async () => {
    const yggRoot = track(seedRepoAtVersion('5.0.0'));
    const ran: string[] = [];
    const migrations = [
      mockMigration('4.3.0', { onRun: () => ran.push('4.3.0') }),
      mockMigration('5.0.0', { onRun: () => ran.push('5.0.0') }),
    ];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(ran).toEqual([]);
    expect(result.migrationActions).toEqual([]);
    expect(result.landedVersion).toBe('5.0.0');
    expect(readVersion(yggRoot)).toBe('5.0.0');
  });

  it('runs only the migrations strictly greater than the current version', async () => {
    const yggRoot = track(seedRepoAtVersion('4.3.0'));
    const ran: string[] = [];
    const migrations = [
      mockMigration('4.0.0', { onRun: () => ran.push('4.0.0') }),
      mockMigration('4.3.0', { onRun: () => ran.push('4.3.0') }),
      mockMigration('5.0.0', { onRun: () => ran.push('5.0.0') }),
    ];

    await runVersionUpgrade({ yggRoot, migrations });

    expect(ran).toEqual(['5.0.0']);
    expect(readVersion(yggRoot)).toBe('5.0.0');
  });

  it('returns fromVersion: null and is a no-op when yg-config.yaml is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yg-mig-fw-empty-'));
    dirsToCleanup.push(root);
    const yggRoot = join(root, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });

    const ran: string[] = [];
    const migrations = [mockMigration('5.0.0', { onRun: () => ran.push('5.0.0') })];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(result.fromVersion).toBeNull();
    expect(result.landedVersion).toBeNull();
    expect(ran).toEqual([]);
  });

  it('returns fromVersion: null and is a no-op when version field is not valid semver', async () => {
    const yggRoot = track(seedRepoAtVersion('not-a-version'));
    const ran: string[] = [];
    const migrations = [mockMigration('5.0.0', { onRun: () => ran.push('5.0.0') })];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(result.fromVersion).toBe('not-a-version');
    expect(result.landedVersion).toBe('not-a-version');
    expect(ran).toEqual([]);
  });

  it('runs no migration steps when the migrations array is empty', async () => {
    // With an empty registry and the target pinned to the current version, there
    // is nothing to do: no actions, no version change. (When the target is ABOVE
    // the current version the runner performs an empty-registry version-lift —
    // covered by the version-lift tests below.)
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const result = await runVersionUpgrade({ yggRoot, migrations: [], targetVersion: '4.0.0' });
    expect(result.migrationActions).toEqual([]);
    expect(result.landedVersion).toBe('4.0.0');
    expect(readVersion(yggRoot)).toBe('4.0.0');
  });

  it('lifts the version to the supported schema when the registry is empty but the project is below it', async () => {
    // No automated transformation exists for the gap, so the runner lifts the
    // config version directly to the supported schema and records one
    // informational action. yg check then flags any stale config fields.
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const result = await runVersionUpgrade({ yggRoot, migrations: [], targetVersion: '5.0.0' });
    expect(result.landedVersion).toBe('5.0.0');
    expect(readVersion(yggRoot)).toBe('5.0.0');
    expect(result.migrationActions.some((a) => a.includes('version updated to 5.0.0'))).toBe(true);
    expect(result.withheld).toBe(false);
  });

  it('orders applicable migrations by semver `to` regardless of input order', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const observed: string[] = [];
    const migrations = [
      mockMigration('5.0.0', { onRun: (root) => observed.push(`5.0.0@${readVersion(root)}`) }),
      mockMigration('4.3.0', { onRun: (root) => observed.push(`4.3.0@${readVersion(root)}`) }),
    ];

    await runVersionUpgrade({ yggRoot, migrations });

    expect(observed[0]).toMatch(/^4\.3\.0@4\.0\.0$/);
    expect(observed[1]).toMatch(/^5\.0\.0@4\.3\.0$/);
  });

  it('collects actions and warnings from every executed migration in order', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const migrations = [
      mockMigration('4.3.0', { actions: ['ran-43'], warnings: ['warn-43'] }),
      mockMigration('5.0.0', { actions: ['ran-50'], warnings: ['warn-50'] }),
    ];

    const result = await runVersionUpgrade({ yggRoot, migrations });

    expect(result.migrationActions).toEqual(['ran-43', 'ran-50']);
    expect(result.migrationWarnings).toEqual(['warn-43', 'warn-50']);
  });

  it('treats omitted bumpVersion field as bumpVersion: true (Pattern A default)', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const migrations = [
      mockMigration('4.3.0' /* no bumpVersion key */),
    ];

    // Pin the target to the migration's own target so the empty-registry
    // version-lift does not run past it — this isolates the bump-default contract.
    await runVersionUpgrade({ yggRoot, migrations, targetVersion: '4.3.0' });

    expect(readVersion(yggRoot)).toBe('4.3.0');
  });

  it('uses detectVersion (re-reads file each call) — version mutations between calls are observed', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const before = await detectVersion(yggRoot);
    expect(before).toBe('4.0.0');

    // Pin the target to 4.3.0 so the empty-registry lift does not advance past
    // the migration's own target — this keeps the re-read assertion exact.
    await runVersionUpgrade({ yggRoot, migrations: [mockMigration('4.3.0')], targetVersion: '4.3.0' });
    expect(await detectVersion(yggRoot)).toBe('4.3.0');

    // A re-run from the new on-disk version skips the already-applied step.
    const ran: string[] = [];
    await runVersionUpgrade({
      yggRoot,
      migrations: [
        mockMigration('4.3.0', { onRun: () => ran.push('4.3.0') }),
        mockMigration('5.0.0', { onRun: () => ran.push('5.0.0') }),
      ],
    });
    expect(ran).toEqual(['5.0.0']);
  });

  it('survives a migration that throws — earlier successful steps stay persisted', async () => {
    const yggRoot = track(seedRepoAtVersion('4.0.0'));
    const migrations: Migration[] = [
      mockMigration('4.3.0'),
      {
        to: '5.0.0',
        description: 'boom',
        run: async () => { throw new Error('boom'); },
      },
    ];

    await expect(runVersionUpgrade({ yggRoot, migrations })).rejects.toThrow(/boom/);
    // The earlier migration's version bump is durable — the throw happens
    // after the 4.3.0 step has already advanced the on-disk version.
    expect(readVersion(yggRoot)).toBe('4.3.0');
  });
});

describe('migration runner — real registered migrations', () => {
  // These exercise the same contract but against the actual MIGRATIONS
  // array, with a seeded repo. They are the contract anchor: if any
  // migration in the registry violates incremental bumping, these
  // tests fail.

  function seedWithSchemas(version: string): string {
    const root = mkdtempSync(join(tmpdir(), 'yg-mig-real-'));
    dirsToCleanup.push(root);
    const yggRoot = join(root, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    mkdirSync(join(yggRoot, 'model'), { recursive: true });
    mkdirSync(join(yggRoot, 'schemas'), { recursive: true });
    writeFileSync(join(yggRoot, 'yg-config.yaml'), `version: "${version}"\n`);
    writeFileSync(
      join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: "Grouping"\n',
    );
    return yggRoot;
  }

  it('seed 4.0.0 → runs the registered chain, lands at 5.1.0', async () => {
    const yggRoot = seedWithSchemas('4.0.0');
    const { MIGRATIONS } = await import('../../src/migrations/index.js');

    const result = await runVersionUpgrade({ yggRoot, migrations: MIGRATIONS });

    expect(result.fromVersion).toBe('4.0.0');
    expect(result.landedVersion).toBe('5.1.0');
    expect(readVersion(yggRoot)).toBe('5.1.0');
  });

  it('seed 4.2.0 → the 5.1.0 migration applies, lands at 5.1.0', async () => {
    const yggRoot = seedWithSchemas('4.2.0');
    const { MIGRATIONS } = await import('../../src/migrations/index.js');

    const result = await runVersionUpgrade({ yggRoot, migrations: MIGRATIONS });

    expect(result.fromVersion).toBe('4.2.0');
    expect(result.landedVersion).toBe('5.1.0');
  });

  it('seed 4.3.0 → only the 5.1.0 migration applies, lands at 5.1.0', async () => {
    const yggRoot = seedWithSchemas('4.3.0');
    const { MIGRATIONS } = await import('../../src/migrations/index.js');

    const result = await runVersionUpgrade({ yggRoot, migrations: MIGRATIONS });

    expect(result.fromVersion).toBe('4.3.0');
    expect(result.landedVersion).toBe('5.1.0');
  });

  it('seed 5.0.0 → the 5.1.0 migration applies, removes schemas/, lands at 5.1.0', async () => {
    const yggRoot = seedWithSchemas('5.0.0');
    const { MIGRATIONS } = await import('../../src/migrations/index.js');

    const result = await runVersionUpgrade({ yggRoot, migrations: MIGRATIONS });

    expect(result.migrationActions.join(' ')).toMatch(/schemas/);
    expect(result.landedVersion).toBe('5.1.0');
    expect(readVersion(yggRoot)).toBe('5.1.0');
  });

  // DELETED: 'seed 4.3.0 with a broken multi-provider reviewer config → chain
  // stops'. Its subject was the old 4.3.0→5.0.0 migration that detected
  // multi-provider reviewer blocks and aborted the chain with a warning. The
  // verdict-lock redesign removed every legacy migration module (the registry is
  // now empty — design §13), so no registered migration validates the reviewer
  // config any more: a below-target project is simply version-lifted, and
  // yg check flags any stale config fields with exact errors. The removed
  // behavior has no replacement here.
});

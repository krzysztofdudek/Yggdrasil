// Unit tests for `yg marketplace` — the command's registration shape, and the
// three pure pieces it is made of: how a marketplace root is located, what a
// fresh manifest says, and what the CI file it writes contains.
//
// Nothing here writes to a repository. Starting one, refusing to overwrite one,
// and the whole of `marketplace check` live in the e2e suite, which drives the
// real binary against repositories built at test time.

import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  CI_WORKFLOW_FILENAME,
  ciWorkflowText,
  findUpwards,
  initialMarketplaceManifest,
  registerMarketplaceCommand,
} from '../../../src/cli/marketplace.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-mkt-unit-'));
  tempDirs.push(dir);
  return dir;
}

describe('the marketplace command surface', () => {
  it('registers init and check, and nothing else', () => {
    const program = new Command();
    registerMarketplaceCommand(program);
    const marketplace = program.commands.find((c) => c.name() === 'marketplace');
    expect(marketplace).toBeDefined();
    expect(marketplace?.commands.map((c) => c.name()).sort()).toEqual(['check', 'init']);
  });
});

describe('locating the repository the user means', () => {
  it('finds a marker in the directory itself', () => {
    const root = newDir();
    writeFileSync(path.join(root, 'yg-marketplace.yaml'), 'schema: yg-marketplace/1\n', 'utf-8');
    expect(findUpwards(root, 'yg-marketplace.yaml')).toBe(path.resolve(root));
  });

  it('finds it from a directory below, the way git does', () => {
    const root = newDir();
    writeFileSync(path.join(root, 'yg-marketplace.yaml'), 'schema: yg-marketplace/1\n', 'utf-8');
    const deep = path.join(root, 'packages', 'house-style', 'naming');
    mkdirSync(deep, { recursive: true });
    expect(findUpwards(deep, 'yg-marketplace.yaml')).toBe(path.resolve(root));
  });

  it('returns null rather than climbing past the filesystem root', () => {
    // A marker name nothing anywhere carries, so the walk is guaranteed to run
    // all the way up and has to terminate on its own.
    expect(findUpwards(newDir(), 'yg-nothing-is-called-this.marker')).toBeNull();
  });
});

describe('what a fresh marketplace starts as', () => {
  it('is a manifest declaring the schema and publishing nothing', () => {
    const parsed = parseYaml(initialMarketplaceManifest()) as { schema: string; packages: unknown[] };
    expect(parsed.schema).toBe('yg-marketplace/1');
    expect(parsed.packages).toEqual([]);
  });

  it('says out loud how to add a package, so nobody has to find the command', () => {
    expect(initialMarketplaceManifest()).toContain('yg pack new');
  });
});

describe('the CI file it writes', () => {
  it('is a workflow of its own, named so a diff shows what created it', () => {
    expect(CI_WORKFLOW_FILENAME).toBe('yg-marketplace.yml');
    expect(ciWorkflowText()).toContain('Written by `yg marketplace init`');
  });

  it('is a valid workflow with one job that runs the check', () => {
    const parsed = parseYaml(ciWorkflowText()) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    expect(Object.keys(parsed.jobs)).toEqual(['check']);
    const runs = parsed.jobs.check.steps.map((s) => s.run).filter((r): r is string => r !== undefined);
    expect(runs).toContain('npx --yes @chrisdudek/yg marketplace check');
  });
});

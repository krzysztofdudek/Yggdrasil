// =============================================================================
// One dead rule, one finding — in `yg check` and in `yg advise` alike.
//
// A rule source that applies to no node is both "effective nowhere" and, when
// nothing attaches it at all, "orphaned". It is reported once, as
// aspect-effective-nowhere (the finding that names the cause); the orphan
// finding stays for what effective-nowhere never reports — a bundle, and a draft
// rule — so no unreferenced aspect is left with zero findings. The advise feed
// nominates the same way, and a decision stored under a retired class name
// (dead-attach, uncovered-hot-spot) still governs the renamed item.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { buildNominations, hashEvidence } from '../../../src/core/advise-nominations.js';
import { applyDecisions } from '../../../src/core/advise-feed.js';
import type { AdviseDecision } from '../../../src/io/advise-decisions-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../../fixtures/sample-project');
const TODAY = new Date('2026-07-12T00:00:00.000Z');

function writeAspect(root: string, id: string, yaml: string, source?: { file: string; content: string }): void {
  const dir = path.join(root, '.yggdrasil', 'aspects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-aspect.yaml'), yaml);
  if (source !== undefined) writeFileSync(path.join(dir, source.file), source.content);
}

const CHECK_MJS = { file: 'check.mjs', content: 'export function check(ctx) { return ctx.files.length < 0 ? [] : []; }\n' };

/** Every finding `about` an aspect: the ones whose subject is `aspects/<id>`. */
function findingsAbout(issues: ReadonlyArray<{ code: string; nodePath?: string }>, id: string): string[] {
  return issues.filter((i) => i.nodePath === `aspects/${id}`).map((i) => i.code);
}

describe('a dead rule is one finding in yg check and one nomination in yg advise', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'yg-dead-rule-'));
    cpSync(FIXTURE, root, { recursive: true });
    // A script rule nothing attaches: dead.
    writeAspect(root, 'lonely-rule', 'name: LonelyRule\ndescription: Attached nowhere.\nreviewer:\n  type: deterministic\n', CHECK_MJS);
    // A bundle nothing attaches: no rule source, so effective-nowhere never speaks for it.
    writeAspect(root, 'lonely-bundle', 'name: LonelyBundle\ndescription: Groups rules, attached nowhere.\nimplies:\n  - requires-logging\n');
    // A parked script rule nothing attaches: effective-nowhere is silent on drafts.
    writeAspect(root, 'lonely-draft', 'name: LonelyDraft\ndescription: Parked and attached nowhere.\nstatus: draft\nreviewer:\n  type: deterministic\n', CHECK_MJS);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('yg check reports a dead rule source once, as aspect-effective-nowhere, never also as an orphan', async () => {
    const graph = await loadGraph(root);
    const { issues } = await runCheck(graph, null);
    expect(findingsAbout(issues, 'lonely-rule')).toEqual(['aspect-effective-nowhere']);
  });

  it('yg check keeps the orphan finding where effective-nowhere is silent — a bundle and a draft — so neither has zero', async () => {
    const graph = await loadGraph(root);
    const { issues } = await runCheck(graph, null);
    expect(findingsAbout(issues, 'lonely-bundle')).toEqual(['orphaned-aspect']);
    expect(findingsAbout(issues, 'lonely-draft')).toEqual(['orphaned-aspect']);
  });

  it('yg advise nominates a dead rule once, under the check code, with the retired dead-attach id as its alias', async () => {
    const graph = await loadGraph(root);
    const noms = buildNominations(graph, { todayUtc: TODAY }).filter((n) => n.id.endsWith(':lonely-rule'));
    expect(noms.map((n) => n.id)).toEqual(['aspect-effective-nowhere:lonely-rule']);
    expect(noms[0].aliases?.map((a) => a.id)).toEqual(['dead-attach:lonely-rule']);
    // The bundle and the draft are still nominated, once each, as orphans.
    const others = buildNominations(graph, { todayUtc: TODAY })
      .filter((n) => n.id.endsWith(':lonely-bundle') || n.id.endsWith(':lonely-draft'))
      .map((n) => n.id)
      .sort();
    expect(others).toEqual(['orphaned-aspect:lonely-bundle', 'orphaned-aspect:lonely-draft']);
  });

  it('a dismissal stored under dead-attach:<id> still dismisses the renamed nomination', async () => {
    const graph = await loadGraph(root);
    const noms = buildNominations(graph, { todayUtc: TODAY });
    // Exactly the record an earlier release wrote: the old id, and the hash that
    // release bound for this evidence.
    const stored: AdviseDecision = {
      v: 1,
      ts: '2026-07-01T00:00:00.000Z',
      id: 'dead-attach:lonely-rule',
      action: 'dismiss',
      evidenceHash: hashEvidence({ source: 'dead-attach', aspectId: 'lonely-rule' }),
      reason: 'parked on purpose',
    };
    const { visible, hidden } = applyDecisions(noms, [stored], TODAY);
    expect(hidden.map((n) => n.id)).toContain('aspect-effective-nowhere:lonely-rule');
    expect(visible.map((n) => n.id)).not.toContain('aspect-effective-nowhere:lonely-rule');
  });

  it('a stored decision under a retired id whose evidence moved no longer applies', async () => {
    const graph = await loadGraph(root);
    const noms = buildNominations(graph, { todayUtc: TODAY });
    const stale: AdviseDecision = {
      v: 1,
      ts: '2026-07-01T00:00:00.000Z',
      id: 'dead-attach:lonely-rule',
      action: 'dismiss',
      evidenceHash: '0'.repeat(64),
      reason: 'about different evidence',
    };
    const { visible } = applyDecisions(noms, [stale], TODAY);
    expect(visible.map((n) => n.id)).toContain('aspect-effective-nowhere:lonely-rule');
  });
});

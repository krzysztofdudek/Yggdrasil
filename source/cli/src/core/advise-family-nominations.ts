/**
 * source/cli/src/core/advise-family-nominations.ts — the family-without-law
 * nomination source: a tight cluster of files sharing no law of its own, read
 * from `.family-candidates.json`, which Grain's `grain propose` and Yggdrasil's
 * own offline miner both write.
 *
 * Split out of the nomination engine beside it to keep that file small: this
 * source is self-contained with one entry point. The engine re-exports the parser and the
 * format constants, so every caller keeps importing them from where it always did.
 */

import type { FamilyCandidate, FamilyCandidatesData, Nomination } from './advise-nominations.js';
import { CLASS_RANK, hashEvidence, quoteData } from './advise-nominations.js';
import { count } from '../utils/count.js';

/**
 * The `.family-candidates.json` format version (`v`) this consumer accepts. It is the
 * REJECT-ON-OLD gate: `parseFamilyCandidates` omits any file whose `v` is not exactly
 * this, so a candidates file mined under a superseded shard schema is rejected at parse
 * rather than rendered as a live family proposal.
 *
 * LOCKSTEP RULE: whenever the AST-shard schema (`facts-cache.CACHE_SCHEMA_VERSION`) moves,
 * bump BOTH this AND `CANDIDATES_SHARD_SCHEMA` together — and have the miner emit the new
 * `v`. Bumping `CANDIDATES_SHARD_SCHEMA` alone re-greens the build-time coupling test while
 * this constant stays put, so the old `v` is still accepted and a candidates file mined
 * under the OLD schema keeps parsing and reads as fresh. The coupling test guards the anchor;
 * THIS `v` gate is what actually rejects the stale file. Exported so the coupling test and the
 * reject-on-old-v guard test can assert the invariant against a real constant, not a literal.
 */
export const SUPPORTED_CANDIDATES_V = 1;
/**
 * The AST-shard schema (`facts-cache.CACHE_SCHEMA_VERSION`) the current candidates format was
 * validated against. The family feature vectors are cut from shards at that schema, so the
 * mined families are only meaningful while the engine's live schema is unchanged. This
 * constant ANCHORS the candidates lineage to the concrete shard schema: a build-time coupling
 * test (`CACHE_SCHEMA_VERSION` must equal this) reddens the build the moment the engine's live
 * schema advances past it. That is the RZ-21 evidence-at-build re-gate — a moved schema fails
 * the build until a human re-validates the miner.
 *
 * LOCKSTEP RULE (see the coupling test): on a moved shard schema, bump BOTH this anchor AND
 * `SUPPORTED_CANDIDATES_V` (and the miner's emitted `v`) together. Re-greening by bumping THIS
 * anchor ALONE leaves `SUPPORTED_CANDIDATES_V` accepting the old `v`, so a candidates file
 * mined under the OLD schema keeps parsing and would render as a live family proposal. The `v`
 * bump is the reject-on-old gate that keeps a stale-schema file from ever rendering as live.
 *
 * Kept out of the runtime freshness gate deliberately — reading the live constant here would
 * couple this read-only command's layer to the relation-analysis subsystem; the coupling test
 * carries it.
 */
export const CANDIDATES_SHARD_SCHEMA = 2;

/**
 * The gate Yggdrasil's own miner applies: no own, port, or narrow-ancestor rule. The
 * nomination states that criterion as fact only for this gate (or a file that names
 * none — every such file predates producers naming themselves, when the miner was the
 * only writer); another producer's gate is named as data instead.
 */
const NARROW_ASPECT_GATE = 'no-narrow-aspect';

/** A non-empty string field, or undefined. */
function optionalText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** True iff `s` is a non-empty string that parses as a real calendar instant. */
function isParseableTs(s: unknown): s is string {
  return typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
}

/** Normalize one raw family entry, or drop it (undefined) when malformed. */
function normalizeFamily(raw: unknown): FamilyCandidate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const members = Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : [];
  const pred = o.fittedPredicate;
  const scopeFilesDraft = Array.isArray(o.scopeFilesDraft)
    ? o.scopeFilesDraft.filter((s): s is string => typeof s === 'string')
    : [];
  const evidence = (o.evidence ?? {}) as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.language !== 'string' ||
    members.length === 0 ||
    pred === null ||
    typeof pred !== 'object' ||
    typeof (pred as Record<string, unknown>).kind !== 'string' ||
    typeof (pred as Record<string, unknown>).value !== 'string'
  ) {
    return undefined;
  }
  const p = pred as Record<string, unknown>;
  return {
    id: o.id,
    language: o.language,
    members,
    fittedPredicate: { kind: p.kind as string, value: p.value as string },
    scopeFilesDraft,
    clusterSize: typeof evidence.clusterSize === 'number' ? evidence.clusterSize : members.length,
    tightness: typeof evidence.tightness === 'number' ? evidence.tightness : 0,
  };
}

/**
 * Freshness-gate + normalize an already-parsed `.family-candidates.json` value.
 * PURE (no I/O — the boundary reads the bytes), so the gate is unit-testable.
 * Returns the fresh payload, or `undefined` when the file is absent-shaped, stale,
 * or garbled — in every not-fresh case the class is silently omitted (never
 * rendered stale as live). Freshness requires, together:
 *   - the file's own format version `v` equals `SUPPORTED_CANDIDATES_V` — the
 *     schema-lineage token, anchored to the live shard schema by the build-time
 *     coupling test (see `CANDIDATES_SHARD_SCHEMA`), so a moved shard schema cannot
 *     ship a file that still reads as fresh here;
 *   - `ts` is a parseable instant (it becomes the `local analysis since <ts>`
 *     provenance label).
 * Individual malformed family entries are dropped; a fresh file with zero (or all
 * -dropped) families yields an empty list (the class runs and produces nothing).
 */
export function parseFamilyCandidates(raw: unknown): FamilyCandidatesData | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== SUPPORTED_CANDIDATES_V) return undefined; // format / schema-lineage moved → stale
  if (!isParseableTs(o.ts)) return undefined; // no usable provenance → omit
  const rawFamilies = Array.isArray(o.families) ? o.families : [];
  const families: FamilyCandidate[] = [];
  for (const f of rawFamilies) {
    const norm = normalizeFamily(f);
    if (norm !== undefined) families.push(norm);
  }
  const producer = optionalText(o.producer);
  const gate = optionalText(o.gate);
  return {
    ts: o.ts,
    ...(producer !== undefined ? { producer } : {}),
    ...(gate !== undefined ? { gate } : {}),
    families,
  };
}

/**
 * Turn each fresh family candidate into ONE T2 nomination. WHAT names the N member
 * files, WHY carries the fitted predicate + tightness + the scope-files skeleton,
 * NEXT names the exact human action and ends with the literal consent suffix — all
 * repo-derived strings rendered as QUOTED DATA with provenance (RZ-5). Ranks below
 * every T1 class; the file `ts` is the freshness tie-break key.
 */
export function familyNominations(data: FamilyCandidatesData): Nomination[] {
  const out: Nomination[] = [];
  const sinceLabel = `local analysis since ${quoteData(data.ts)}`;
  const provenance = `${quoteData(data.file ?? '.family-candidates.json')}:${quoteData(data.ts)}`;
  // Who measured and what "without a law" meant, as data. Only the miner's own gate
  // licenses the "no own, port, or narrow-ancestor rule" sentence; another producer's
  // gate answered a different question, so the sentence names that gate instead.
  const gate = data.gate;
  const minersGate = gate === undefined || gate === NARROW_ASPECT_GATE;
  const lawless = minersGate
    ? 'share no own, port, or narrow-ancestor rule'
    : `have no rule under the gate '${quoteData(gate)}'`;
  // The WHAT line makes the same claim in fewer words, so it follows the same gate. And only the
  // miner checks that its fitted scope leaves every non-member out; another producer only drops the
  // members its predicate misses, so for it the scope selects the family and nothing more is claimed.
  const lawlessShort = minersGate ? 'share no rule of their own' : `have no rule under the gate '${quoteData(gate)}'`;
  const fits = minersGate ? 'covers exactly them' : 'selects them (its producer does not check that it leaves every other file out)';
  const measuredBy =
    data.producer !== undefined && data.gate !== undefined
      ? ` Measured by '${quoteData(data.producer)}' under the gate '${quoteData(data.gate)}'.`
      : data.producer !== undefined
        ? ` Measured by '${quoteData(data.producer)}'.`
        : data.gate !== undefined
          ? ` Measured under the gate '${quoteData(data.gate)}'.`
          : '';
  for (const fam of data.families) {
    const n = fam.members.length;
    const memberList = fam.members.map((m) => `'${quoteData(m)}'`).join(', ');
    const predQ = quoteData(fam.fittedPredicate.value);
    const scopeList = fam.scopeFilesDraft.map((s) => `'${quoteData(s)}'`).join(', ');
    out.push({
      id: `family-without-law:${fam.id}`,
      classRank: CLASS_RANK.familyWithoutLaw,
      what: `A look-alike group — ${count(n, 'file')} ${lawlessShort}: ${memberList}.`,
      why:
        `${sinceLabel}: these files cluster tightly (tightness ${fam.tightness}) yet ${lawless} ` +
        `— the fingerprint of a convention with no rule of its own. A ` +
        `fitted scope \`${predQ}\` ${fits}; scope skeleton ${scopeList}.${measuredBy} Provenance: ${provenance}.`,
      // NEXT names the exact human action and ends with the literal consent suffix
      // (T2 uses "requires the user's consent", never the T0/T1 approval phrasing).
      next: `Create a draft aspect scoped to \`${predQ}\` for these ${count(n, 'file')}, then supply the rationale — never invent it — and ask the user to approve it first.`,
      // Bind to the family identity + fitted reach + member set + provenance: a
      // re-mine that changes members or the predicate moves the hash, so a
      // dismissed family returns as new evidence. The producer joins the hash only
      // when the file names one: a dismissal recorded against one oracle's evidence
      // must not silence the other's, while a file without the field keeps the
      // hash it always had, so no earlier dismissal goes stale.
      evidenceHash: hashEvidence({
        source: 'family-without-law',
        familyId: fam.id,
        predicate: fam.fittedPredicate.value,
        members: fam.members.join('|'),
        ts: data.ts,
        ...(data.producer !== undefined ? { producer: data.producer } : {}),
      }),
      evidenceTs: data.ts,
    });
  }
  return out;
}

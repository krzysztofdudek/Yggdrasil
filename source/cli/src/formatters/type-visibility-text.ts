/**
 * The sentences the type-level coverage tier is reported in: why an attached
 * rule does not run on a type-covered file, where a type's inherited parent
 * chain stops, and an aspect `implies` cycle the cascade absorbed. Each is
 * shared verbatim by every surface that reports the fact (`yg check`,
 * `yg context --file`, `yg owner --file`, the portal), so the wording can never
 * drift between them. Words only: the engine decides every fact
 * (core/type-visibility.ts, core/type-effective.ts) and hands it over as data.
 */
import type { ChainTermination, TypeCascadeCycle, TypeVisibilityReason } from '../model/type-visibility.js';

/**
 * Plain-language sentence for where a type's inherited chain stops and why —
 * shared verbatim between `yg check`'s per-type block and `yg context --file`
 * so the wording never drifts between the two surfaces.
 *
 * 'no-parents' phrasing deliberately does NOT claim whether the type omitted
 * `parents:` or wrote an explicit `parents: []`: the graph loader normalizes
 * both to the identical absent-parents state before either ever reaches this
 * function (`architecture-parser.ts` turns a YAML `parents: []` into
 * `undefined` at load time), so a real, loaded graph can never tell the two
 * apart here. Claiming "no parents declared" would be false for an author who
 * wrote the explicit empty list; this phrasing is true either way.
 * 'empty-parents' keeps its own distinct, accurate text — reachable only via
 * a hand-built Graph that bypasses the parser (never a real loaded project;
 * see type-effective.test.ts) — so it is not merged into 'no-parents'.
 */
export function describeChainTermination(t: ChainTermination): string {
  const reasonPhrase: Record<ChainTermination['reason'], string> = {
    fork: `a fork (${t.candidates.join(' | ')})`,
    cycle: `a cycle back to '${t.candidates[0]}'`,
    'no-parents': `'${t.candidates[0]}' — it has no parent type to inherit from`,
    'empty-parents': `'${t.candidates[0]}' — an explicit empty parents list`,
  };
  return `inherited rules stop at ${reasonPhrase[t.reason]}`;
}

/**
 * The `why` clause for an absorbed cascade cycle, shared VERBATIM by every
 * surface that reports one — `yg owner --file`, `yg context --file`, and `yg
 * check`'s per-type block/zero-enforcement rollup — so the wording can never
 * drift between them. Each surface still writes its own `what`/`next` around
 * this, since those differ (a single-file error vs. a repo-wide summary).
 */
export function describeCascadeCycle(cycle: TypeCascadeCycle): string {
  return `The aspect graph has an implies cycle${cycle.aspectId ? ` at '${cycle.aspectId}'` : ''} — the cascade cannot tell which of the type's rules apply until that cycle is broken.`;
}

/** Short, plain-language phrase for a reason — shared by every render surface so the vocabulary never drifts between them. */
export function describeTypeVisibilityReason(reason: TypeVisibilityReason): string {
  switch (reason) {
    case 'when-not-satisfied': return 'its attach condition (when:) was not satisfied on this file';
    case 'draft': return 'the rule is still draft (not checked)';
    case 'whole-unit-rule': return 'it is a per: node rule and this file has no component to run it on';
    case 'scope.files-excluded': return "excluded by the rule's own scope.files filter";
    case 'aspect-undefined': return 'the architecture attaches an aspect id with no matching aspect definition';
    case 'unreadable': return 'the file could not be read, so it cannot be reviewed';
    case 'binary-subject': return 'a binary file cannot be reviewed by a reviewer rule';
    case 'read-beyond-architecture': return "it tried to read a file outside what the architecture allows this file's type to depend on";
    case 'node-context-required': return 'it needs component context (ctx.node / ctx.graph) that a type-covered file does not have';
    case 'companion-context-failed': return 'its companion could not resolve a dependency for this file';
  }
}

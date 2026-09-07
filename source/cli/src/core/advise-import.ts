/**
 * source/cli/src/core/advise-import.ts — reading a proposal document another
 * tool produced, and turning it into entries for this graph's attention feed.
 *
 * The layering rule this exists to keep: a lower layer's file format must never
 * be read by hand from above, and a higher layer's conclusions must never arrive
 * disguised as this graph's own. So a document is accepted only when it names a
 * schema this build understands, only its documented fields are read, and every
 * item's evidence is kept VERBATIM under the producer's name — what was measured
 * stays visibly separate from what this graph concluded.
 *
 * IMPORTING IS NOT ACCEPTING. Every item becomes a proposal in the feed, with
 * the same standing as one the graph nominated itself: dismissing, deferring or
 * acting on it remains the user's act.
 *
 * Pure: it parses text and returns records. Reading the file and writing the
 * register both happen at the command boundary.
 */

import { hashString } from '../io/hash.js';
import { IMPORTED_ADVICE_KINDS } from '../io/advise-imported-store.js';
import type { ImportedAdvice, ImportedAdviceKind } from '../io/advise-imported-store.js';
import type { IssueMessage } from '../model/validation.js';

/** The one document schema this build reads proposals from. */
export const GRAIN_ADVICE_SCHEMA = 'grain-advice/1';

/** The producer recorded on every item read from a `grain-advice/1` document. */
export const GRAIN_SOURCE = 'grain';

/** What a parse produced: the records to record, or the reason it was refused. */
export type ParseImportOutcome =
  | { ok: true; records: ImportedAdvice[] }
  | { ok: false; error: IssueMessage };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * The idempotence key: kind, components and the commit the producer measured at.
 *
 * Measured-at is part of it deliberately. The same proposal at the same commit is
 * the same fact, however many times a pipeline hands it over; the same proposal
 * measured again at a LATER commit is a new one, because the evidence behind it
 * was taken again over code that has moved.
 */
export function importKey(kind: string, nodes: readonly string[], at: string | null): string {
  return hashString(JSON.stringify({ kind, nodes, at: at ?? null }));
}

/**
 * Parse a proposal document into records for the register.
 *
 * `nowIso` is the importing command's own clock, injected — this module keeps
 * none of its own.
 */
export function parseGrainAdvice(text: string, nowIso: string): ParseImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: {
        what: `The proposal document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        why: 'Proposals arrive as one JSON document naming the schema they follow; anything else cannot be read without guessing at its shape, and a guess would put claims into this graph that nobody made.',
        next: `Check that the file is the whole document a producer wrote, e.g. the output of a tool's own --json form.`,
      },
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: {
        what: 'The proposal document is not a JSON object.',
        why: 'A proposal document is one object naming its schema and carrying its items; a bare array or scalar names neither.',
        next: `Supply a document whose top level is an object with "schema": "${GRAIN_ADVICE_SCHEMA}".`,
      },
    };
  }

  if (parsed.schema !== GRAIN_ADVICE_SCHEMA) {
    const named = typeof parsed.schema === 'string' ? `'${parsed.schema}'` : 'nothing';
    return {
      ok: false,
      error: {
        what: `The proposal document names ${named} as its schema, not '${GRAIN_ADVICE_SCHEMA}'.`,
        why: 'A document is read by the contract it names. Reading one whose shape this build does not know would mean guessing which fields mean what — exactly the fragility a versioned schema exists to remove.',
        next: `Supply a '${GRAIN_ADVICE_SCHEMA}' document, or upgrade the CLI if the producer has moved to a newer contract.`,
      },
    };
  }

  const at = typeof parsed.at === 'string' && parsed.at !== '' ? parsed.at : null;
  const items = parsed.items;
  if (!Array.isArray(items)) {
    return {
      ok: false,
      error: {
        what: `The '${GRAIN_ADVICE_SCHEMA}' document has no 'items' list.`,
        why: 'Items are the proposals themselves; a document without them carries nothing to bring into the feed.',
        next: 'Check that the producer wrote a complete document — an empty run still emits "items": [].',
      },
    };
  }

  const records: ImportedAdvice[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: unknown = items[i];
    if (!isPlainObject(item)) {
      return {
        ok: false,
        error: {
          what: `Item ${i} of the proposal document is not an object.`,
          why: 'Each item is one proposal: a kind, the components it is about, its evidence and its own sentence. A non-object item names none of those.',
          next: 'Fix the producing tool, or remove the malformed item and import again.',
        },
      };
    }
    const kind = item.kind;
    if (typeof kind !== 'string' || !(IMPORTED_ADVICE_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        error: {
          what: `Item ${i} has kind ${typeof kind === 'string' ? `'${kind}'` : 'none'}, which this graph has no vocabulary for.`,
          why: `A proposal is acted on in the graph's own terms — ${IMPORTED_ADVICE_KINDS.join(', ')}. Storing a kind nobody can act on would put an item in the feed with no next step behind it.`,
          next: `Import a document whose items are one of: ${IMPORTED_ADVICE_KINDS.join(', ')}.`,
        },
      };
    }
    if (!isStringArray(item.nodes) || item.nodes.length === 0) {
      return {
        ok: false,
        error: {
          what: `Item ${i} (kind '${kind}') names no components.`,
          why: 'A proposal is about something in the graph; without the components it concerns there is nothing for a reader to look at or act on.',
          next: 'Fix the producing tool so each item names the components it is about.',
        },
      };
    }
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      return {
        ok: false,
        error: {
          what: `Item ${i} (kind '${kind}') carries no text.`,
          why: "Each item's own sentence is what the feed shows; this graph deliberately does not write one on the producer's behalf, because that would blur what was measured with what was concluded.",
          next: 'Fix the producing tool so each item carries its own one-line statement.',
        },
      };
    }

    const record: ImportedAdvice = {
      v: 1,
      ts: nowIso,
      key: importKey(kind, item.nodes, at),
      source: GRAIN_SOURCE,
      schema: GRAIN_ADVICE_SCHEMA,
      at,
      kind: kind as ImportedAdviceKind,
      nodes: item.nodes,
      // VERBATIM: the producer's own evidence object, never re-derived, never
      // summarized. An item with none records an empty one rather than a claim.
      evidence: isPlainObject(item.evidence) ? item.evidence : {},
      text: item.text,
    };
    if (isStringArray(item.candidates)) record.candidates = item.candidates;
    if (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) {
      record.confidence = item.confidence;
    }
    records.push(record);
  }

  return { ok: true, records };
}

/**
 * Split parsed records into the ones this register has never seen and the ones
 * it already holds, so a repeated import adds nothing.
 */
export function partitionNewImports(
  records: readonly ImportedAdvice[],
  existing: readonly ImportedAdvice[],
): { fresh: ImportedAdvice[]; alreadyHeld: ImportedAdvice[] } {
  const held = new Set(existing.map((r) => r.key));
  const fresh: ImportedAdvice[] = [];
  const alreadyHeld: ImportedAdvice[] = [];
  // A document may itself name one proposal twice; the second is already held
  // the moment the first is taken, so the set grows as we go.
  for (const record of records) {
    if (held.has(record.key)) {
      alreadyHeld.push(record);
      continue;
    }
    held.add(record.key);
    fresh.push(record);
  }
  return { fresh, alreadyHeld };
}

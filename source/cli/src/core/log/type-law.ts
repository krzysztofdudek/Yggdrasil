/**
 * source/cli/src/core/log/type-law.ts — law that reaches a whole node type, and
 * the record that someone admitted it.
 *
 * A rule attached to one component governs that component; the agent working
 * there raises it freely. A rule attached to a node type governs every file of
 * that type, present and future — it is shared vocabulary, and shared
 * vocabulary is admitted by the people who own the code, not by whichever agent
 * happened to write it. So a rule that reaches a type runs as advice until
 * someone admits it, and it may stand `enforced` there only once its own log
 * holds a ratification of the version that stands now, for every type it
 * reaches.
 *
 * Three things live here, all pure over the loaded graph and the rule's log:
 *
 *  - REACH: which types a rule reaches, and at what status. A rule reaches a
 *    type when the type lists it, or when a rule the type lists implies it
 *    (the implied rule governs every node of the type just the same). `when:`
 *    filters are deliberately ignored: a filter narrows which nodes a rule
 *    applies to today, not whose law it is.
 *  - VERSION: a short fingerprint of what the rule demands — its rule source
 *    with support files, its companion, its applicability and scope, and for a
 *    reviewer rule the description the reviewer reads. Status is not part of
 *    it: moving a ratified rule from advisory to enforced is exactly what a
 *    ratification permits, and must not void it.
 *  - RATIFICATION: one line opening a rule-log entry, readable as a sentence
 *    and read back as a fact — which types, which version, admitted by whom.
 *
 * A ratification is a record, never a switch: writing one changes no status and
 * invalidates no verdict.
 */

import type { AspectDef, AspectStatus, Graph } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import { hashString } from '../../io/hash.js';
import { codePointCanonicalJson } from '../pair-hash.js';
import { companionHashFor, ruleHashFor } from '../pair-inputs.js';
import { appendAspectLogEntry, readAspectLog } from './aspect-log.js';

/** How many hex characters of the fingerprint a ratification carries. */
const VERSION_LENGTH = 16;

/** Every type a rule reaches, with the status it stands at there. */
type TypeReach = Map<string, AspectStatus>;

function stricter(a: AspectStatus | undefined, b: AspectStatus): AspectStatus {
  if (a === undefined) return b;
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

/**
 * For every rule that reaches at least one node type: the types, each with the
 * strictest status the rule stands at there.
 *
 * Status per attachment follows the cascade the engine uses on a node: the
 * status the type's attachment declares, else the rule's own default; an
 * implied rule takes the stricter of its implier's status and its own default,
 * unless the edge says `own-default`, and a draft implier implies nothing.
 */
export function typeLawReach(graph: Graph): Map<string, TypeReach> {
  const byId = new Map<string, AspectDef>(graph.aspects.map((a) => [a.id, a]));
  const reach = new Map<string, TypeReach>();

  for (const [typeId, def] of Object.entries(graph.architecture.node_types)) {
    const here = new Map<string, AspectStatus>();
    for (const aspectId of def.aspects ?? []) {
      const aspect = byId.get(aspectId);
      if (aspect === undefined) continue;
      here.set(aspectId, stricter(here.get(aspectId), def.aspectStatus?.[aspectId] ?? aspect.status ?? 'enforced'));
    }
    // Implies closure: monotone over a three-step lattice, so it settles even on
    // a cyclic graph (which the validator refuses on its own account).
    let changed = true;
    while (changed) {
      changed = false;
      for (const [implierId, implierStatus] of [...here]) {
        if (implierStatus === 'draft') continue;
        const implier = byId.get(implierId);
        for (const impliedId of implier?.implies ?? []) {
          const implied = byId.get(impliedId);
          if (implied === undefined) continue;
          const own = implied.status ?? 'enforced';
          const inherited = (implier?.impliesStatusInherit?.[impliedId] ?? 'strictest') === 'own-default' ? own : stricter(implierStatus, own);
          const next = stricter(here.get(impliedId), inherited);
          if (next !== here.get(impliedId)) {
            here.set(impliedId, next);
            changed = true;
          }
        }
      }
    }
    for (const [aspectId, status] of here) {
      let types = reach.get(aspectId);
      if (types === undefined) reach.set(aspectId, (types = new Map()));
      types.set(typeId, stricter(types.get(typeId), status));
    }
  }
  return reach;
}

/**
 * Whether a rule demands anything of its own. A bundle (an aggregate rule)
 * only implies others; each rule it implies is weighed on its own, so the
 * bundle itself has nothing to admit.
 */
function carriesLaw(aspect: AspectDef): boolean {
  return aspect.reviewer.type !== 'aggregate';
}

/** The version of a rule a ratification admits: what it demands, fingerprinted. */
export function ruleVersion(aspect: AspectDef): string {
  const kind = aspect.reviewer.type;
  const payload = codePointCanonicalJson({
    kind,
    rule: kind === 'llm' ? ruleHashFor(aspect, 'content.md') : kind === 'deterministic' ? ruleHashFor(aspect, 'check.mjs') : null,
    companion: companionHashFor(aspect) ?? null,
    description: kind === 'llm' ? (aspect.description ?? '') : null,
    when: aspect.when ?? null,
    scope: aspect.scope ?? null,
  });
  return hashString(payload).slice(0, VERSION_LENGTH);
}

const RATIFIED_PREFIX = 'Ratified for type';

/** The one line a ratification entry opens with. */
export function ratificationLine(args: { types: readonly string[]; version: string; by: string }): string {
  const noun = args.types.length === 1 ? 'type' : 'types';
  return `Ratified for ${noun} ${args.types.join(', ')}: rule version ${args.version}, admitted by ${args.by}.`;
}

const RATIFIED_RE = /^Ratified for types? (.+?): rule version ([0-9a-f]+), admitted by (.+?)\.?$/;

/** What a ratification entry admitted, read back from its opening line; null for any other entry. */
export function parseRatification(body: string): { types: string[]; version: string; by: string } | null {
  const line = body.split('\n').find((l) => l.trimStart().startsWith(RATIFIED_PREFIX));
  if (line === undefined) return null;
  const m = RATIFIED_RE.exec(line.trim());
  if (m === null) return null;
  return { types: m[1].split(',').map((t) => t.trim()).filter((t) => t !== ''), version: m[2], by: m[3] };
}

/** One rule standing enforced on a type whose current version nobody admitted there. */
export interface UnratifiedTypeLaw {
  aspectId: string;
  /** The types it stands enforced on without a ratification of this version, sorted. */
  types: string[];
  /** Every type it reaches, sorted — what a ratification written now would cover. */
  reach: string[];
  version: string;
  /** The newest ratification of an EARLIER version, when there is one: the rule changed since. */
  earlier?: { datetime: string; version: string };
  /** Set when the rule's log could not be read, so no ratification could be found in it. */
  logUnreadable?: string;
}

/**
 * The types a rule's in-force ratifications of `version` cover, plus the newest
 * ratification of any other version (how a reader learns the rule changed).
 */
async function ratifiedTypes(graph: Graph, aspectId: string, version: string): Promise<{ types: Set<string>; earlier?: { datetime: string; version: string }; unreadable?: string }> {
  const log = await readAspectLog(graph.rootPath, aspectId);
  if (!log.ok) return { types: new Set(), unreadable: log.error.what };
  const types = new Set<string>();
  let earlier: { datetime: string; version: string } | undefined;
  for (const entry of log.entries) {
    if (entry.supersededBy !== undefined) continue;
    const r = parseRatification(entry.body);
    if (r === null) continue;
    if (r.version === version) for (const t of r.types) types.add(t);
    else earlier ??= { datetime: entry.datetime, version: r.version };
  }
  return { types, earlier, unreadable: undefined };
}

/**
 * Every rule standing enforced on a node type without a ratification of the
 * version that stands now, for that type. Sorted by rule id.
 */
export async function findUnratifiedTypeLaw(graph: Graph): Promise<UnratifiedTypeLaw[]> {
  const out: UnratifiedTypeLaw[] = [];
  const reach = typeLawReach(graph);
  for (const aspect of [...graph.aspects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const types = reach.get(aspect.id);
    if (types === undefined || !carriesLaw(aspect)) continue;
    const enforced = [...types].filter(([, s]) => s === 'enforced').map(([t]) => t).sort();
    if (enforced.length === 0) continue;
    const version = ruleVersion(aspect);
    const found = await ratifiedTypes(graph, aspect.id, version);
    const missing = enforced.filter((t) => !found.types.has(t));
    if (missing.length === 0) continue;
    out.push({
      aspectId: aspect.id,
      types: missing,
      reach: [...types.keys()].sort(),
      version,
      ...(found.earlier !== undefined && { earlier: found.earlier }),
      ...(found.unreadable !== undefined && { logUnreadable: found.unreadable }),
    });
  }
  return out;
}

/** Who a grandfathered ratification names: nobody decided it now, and the entry says so. */
const GRANDFATHERED_BY = 'the graph as it stood when it took up type-law ratification (yg init --upgrade)';

const GRANDFATHERED_REASON =
  'This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.';

/**
 * Record, once, every rule that stands enforced on a type without a
 * ratification as the law the graph already had. Called only by the upgrade
 * that turns ratification on, so law that existed before the requirement is not
 * silently demoted and does not turn a build red overnight. Returns the rules
 * it recorded, and those whose log refused the entry (with the reason).
 */
export async function grandfatherTypeLaw(graph: Graph, nowMs: number): Promise<{ recorded: Array<{ aspectId: string; types: string[] }>; failed: Array<{ aspectId: string; reason: string }> }> {
  const recorded: Array<{ aspectId: string; types: string[] }> = [];
  const failed: Array<{ aspectId: string; reason: string }> = [];
  for (const item of await findUnratifiedTypeLaw(graph)) {
    const result = await appendAspectLogEntry({
      yggRootPath: graph.rootPath,
      aspectId: item.aspectId,
      reasonText: `${ratificationLine({ types: item.types, version: item.version, by: GRANDFATHERED_BY })}\n\n${GRANDFATHERED_REASON}`,
      nowMs,
    });
    if (result.ok) recorded.push({ aspectId: item.aspectId, types: item.types });
    else failed.push({ aspectId: item.aspectId, reason: result.error.what });
  }
  return { recorded, failed };
}

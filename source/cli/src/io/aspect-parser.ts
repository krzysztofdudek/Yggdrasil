import { readFile } from 'node:fs/promises';
import { escapesRepo } from '../utils/repo-path-escape.js';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileExistsSync } from './graph-fs.js';
import type { AspectDef, AspectReviewerSpec, AspectStatus, StatusInherit, ScopeDef, ErrsDirection } from '../model/graph.js';
import { ASPECT_STATUS_VALUES, ERRS_DIRECTION_VALUES } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import type { CheckCode } from '../model/issue-code.js';
import type { WhenPredicate } from '../model/when.js';
import { readArtifacts, readSupportFileHashes, ruleDirSymlinks, symlinkOnPath } from './artifact-reader.js';
import { mergeAdaptOverAspect, parseAspectAdapt, resolveAspectConfig } from './aspect-adapt-parser.js';
import { ADAPT_FILENAME, ADAPT_LOG_FILENAME } from '../model/packages.js';
import type { PackageConfigKeyDef } from '../model/packages.js';
import { parseWhen, parseAspectAttachment } from '../utils/when-parser.js';
import { parseFileWhen, WhenPredicateInvalidError } from '../utils/file-when-parser.js';
import { aspectStatusInvalidMessage, aspectReviewByMalformedMessage, impliesStatusInheritInvalidMessage } from '../formatters/aspect-status-messages.js';
import { toPosixPath } from '../utils/posix.js';
import { describeUnknownKeys, findUnknownKeys, type RetiredKeys } from '../utils/known-keys.js';
import { keysOf, retiredOf, schemaProblems } from '../utils/file-schema.js';
import { ASPECT_REFERENCE, ASPECT_REVIEWER, ASPECT_ROOT, ASPECT_SCOPE } from '../utils/file-formats-graph.js';

/**
 * Bare ISO calendar-date shape for `review_by:` — `YYYY-MM-DD`, nothing else.
 * DELIBERATELY a fresh regex, NOT DATETIME_STRICT (which requires a full
 * `T..:..:..Z` timestamp): review_by is a day-granularity review cadence, not a
 * log timestamp. The regex only pins the digit shape; calendar validity (a real
 * month/day) is enforced separately by isValidReviewByDate below.
 */
const REVIEW_BY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True iff `value` is both shaped like `YYYY-MM-DD` AND a real calendar date.
 * The round-trip guard rejects overflow dates the bare regex would let through
 * (e.g. `2027-13-40`, `2027-02-30`): JS Date normalizes an out-of-range month or
 * day into a different date, so a component that fails to survive the UTC
 * round-trip is not a valid calendar date.
 *
 * Exported as the single source of truth for the bare ISO calendar-date guard —
 * both `review_by:` parsing here and the `advise defer --until` command validate
 * a `YYYY-MM-DD` day against exactly this rule, so the two can never diverge.
 */

/**
 * The keys the top level of a yg-aspect.yaml accepts, from the aspect schema
 * (utils/file-formats-graph.ts) that `yg schemas read aspect` prints. Anything
 * else is refused by name with the nearest accepted key (aspect-unknown-key). A
 * rule that needs a key a later release adds says so through its package's
 * requires.yg, which an install enforces.
 */
const ASPECT_KEYS = keysOf(ASPECT_ROOT);

/** yg-aspect.yaml keys an earlier release read (or never read), and what became of each. `yg init --upgrade` removes them. */
export const RETIRED_ASPECT_KEYS: RetiredKeys = retiredOf(ASPECT_ROOT);

export function isValidReviewByDate(value: string): boolean {
  if (!REVIEW_BY_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

export type ParseAspectResult =
  | { ok: true; aspect: AspectDef }
  | { ok: false; aspectId: string; errors: Array<{ code: CheckCode; messageData: IssueMessage }> };

/**
 * What a caller knows about an aspect that arrived inside a package, and that the
 * aspect's own directory cannot tell you.
 *
 * Ids and `implies` inside a package are RELATIVE — a package is written without
 * knowing where a consumer will put it, so `implies: [rule-a]` has to mean "the
 * rule-a in this package" and nothing else. The loader knows the install path and
 * supplies it here; every relative id is prefixed with it, which is also what
 * makes the existing implies-cycle check operate on real, installed ids rather
 * than on names that could collide across two packages.
 */
export interface AspectPackageContext {
  /** The package's own name, quoted in refusals so the reader knows whose rule this is. */
  packageName: string;
  /** Install prefix for every id in this package, e.g. `packages/acme/law/style`. */
  idPrefix: string;
  /** Aspect directory names the package declares — the set a relative `implies` may name. */
  aspectDirs: string[];
  /** This aspect's own directory name inside the package. */
  relativeId: string;
  /** Configuration keys this package declares for THIS aspect. Absent block ⇒ empty. */
  configSchema: Record<string, PackageConfigKeyDef>;
}

export interface ParseAspectOptions {
  /** Present when this aspect was installed from a package. */
  package?: AspectPackageContext;
  /**
   * Repository root, used to resolve an adapt's `companion:` path and to check it
   * is really there. Derived from the aspect directory when the caller omits it,
   * which is exact for the real `.yggdrasil/aspects/<id>` layout.
   */
  projectRoot?: string;
}

/** The refusal for a rule whose sources run through a symbolic link (see io/artifact-reader.ts). */
export function aspectSourceSymlinkMessage(aspectId: string, links: string[]): IssueMessage {
  return {
    what: `Aspect '${aspectId}' is built from a symbolic link: ${links.join(', ')}.`,
    why: 'A rule\'s files are verdict inputs, and a link is followed by some readers and skipped by others — the rule would be reviewed or hashed as something other than what runs — and it can point outside the repository, so each machine could see a different rule.',
    next: `Replace ${links.length === 1 ? 'the link' : 'each link'} with the file itself (copy it into the rule), or share the rule as a package; then run yg check.`,
  };
}

/**
 * The repository root, worked back from an aspect directory and its id.
 *
 * An aspect always lives at `<root>/.yggdrasil/aspects/<id>`, so climbing one
 * level per id segment and then two more lands on the root. Used only when a
 * caller does not supply the root explicitly.
 */
function deriveProjectRoot(aspectDir: string, id: string): string {
  const upFromId = id.split('/').map(() => '..');
  return path.resolve(aspectDir, ...upFromId, '..', '..');
}

/**
 * The `references:` block of one yg-aspect.yaml: a list of repo-relative paths
 * (bare, or `{ path, description }`), normalized to POSIX, refused when blank,
 * escaping the repository, duplicated, or declared on a rule with no LLM prompt
 * to carry them (deterministic or aggregate). Returns the FIRST problem found,
 * exactly as the aspect parser reports it.
 */
function parseReferences(
  rawRefs: unknown,
  reviewerType: AspectReviewerSpec['type'],
  aspectId: string,
  aspectYamlPath: string,
  /** The consumer's adaptation file when this aspect is an installed package copy — its own files are not the consumer's to edit. */
  packageAdaptPath: string | undefined,
):
  | { ok: true; value: Array<{ path: string; description?: string }> }
  | { ok: false; errors: Array<{ code: CheckCode; messageData: IssueMessage }> }
{
  if (!Array.isArray(rawRefs)) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-reference-invalid-form',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: 'references' must be an array`,
          why: 'references is a list of file paths or { path, description } objects',
          next: 'change references: to a YAML sequence',
        },
      }],
    };
  }
  // aspect-references-on-deterministic: cross-field check
  if (reviewerType === 'deterministic') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-references-on-deterministic',
        messageData: {
          what: `Aspect '${aspectId}' declares 'references:' but reviewer.type is 'deterministic'.`,
          why: 'reference files are passed to the reviewer in the prompt. A script rule runs a local check.mjs and ignores them.',
          next: packageAdaptPath !== undefined
            ? `remove 'references:' from ${toPosixPath(packageAdaptPath)} — the adaptation beside the installed copy. A script rule takes its settings through ctx.config instead; the package's own files are not yours to edit.`
            : `remove 'references:' from .yggdrasil/aspects/${aspectId}/yg-aspect.yaml, or embed lookup tables in check.mjs directly, or change reviewer.type to 'llm'.`,
        },
      }],
    };
  }
  // An aggregating aspect has no LLM reviewer prompt, so references go nowhere.
  if (reviewerType === 'aggregate') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-references-on-aggregate',
        messageData: {
          what: `Aspect '${aspectId}' declares 'references:' but it is a bundle (no content.md, no check.mjs).`,
          why: 'reference files are passed to the reviewer in the prompt. A bundle has no reviewer of its own — it only groups implied aspects, so references would never be read.',
          next: packageAdaptPath !== undefined
            ? `remove 'references:' from ${toPosixPath(packageAdaptPath)} — the adaptation beside the installed copy. A rule that only bundles others has no reviewer to read them.`
            : `remove 'references:' from .yggdrasil/aspects/${aspectId}/yg-aspect.yaml, or add a content.md and move the references onto that reviewer rule.`,
        },
      }],
    };
  }
  const references: Array<{ path: string; description?: string }> = [];
  const seenPaths = new Set<string>();
  for (let i = 0; i < rawRefs.length; i++) {
    const entry = rawRefs[i];
    let rawPath: string;
    let description: string | undefined;
    if (typeof entry === 'string') {
      rawPath = entry;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.path !== 'string') {
        return {
          ok: false,
          errors: [{
            code: 'aspect-reference-invalid-form',
            messageData: {
              what: `yg-aspect.yaml at ${aspectYamlPath}: references[${i}] object missing string 'path' field`,
              why: 'each reference entry must be a string OR an object { path: string, description?: string }',
              next: `set references[${i}].path to a string path`,
            },
          }],
        };
      }
      const unknownRefKeys = findUnknownKeys(obj, keysOf(ASPECT_REFERENCE));
      if (unknownRefKeys.length > 0) {
        return {
          ok: false,
          errors: [{
            code: 'aspect-reference-invalid-form',
            messageData: {
              what: `yg-aspect.yaml at ${aspectYamlPath}: ${describeUnknownKeys(`references[${i}]`, unknownRefKeys, keysOf(ASPECT_REFERENCE))}`,
              why: 'each reference entry must be a string OR an object { path: string, description?: string }',
              next: `correct or remove '${unknownRefKeys[0].key}' in references[${i}]`,
            },
          }],
        };
      }
      rawPath = obj.path;
      if (obj.description !== undefined) {
        if (typeof obj.description !== 'string') {
          return {
            ok: false,
            errors: [{
              code: 'aspect-reference-invalid-form',
              messageData: {
                what: `yg-aspect.yaml at ${aspectYamlPath}: references[${i}].description must be a string when present`,
                why: 'description is optional but must be a string',
                next: `remove the description or set it to a string at references[${i}]`,
              },
            }],
          };
        }
        description = obj.description;
      }
    } else {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reference-invalid-form',
          messageData: {
            what: `yg-aspect.yaml at ${aspectYamlPath}: references[${i}] is neither a string nor an object`,
            why: 'each reference entry must be a string OR an object { path: string, description?: string }',
            next: `replace references[${i}] with a string path or { path: ..., description: ... }`,
          },
        }],
      };
    }
    // normalize: trim, \ -> /, strip trailing /
    const normalized = toPosixPath(rawPath.trim());
    // aspect-reference-blank-path
    if (normalized === '') {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reference-blank-path',
          messageData: {
            what: `yg-aspect.yaml at ${aspectYamlPath}: references[${i}] is blank or whitespace-only`,
            why: 'every reference must declare a non-empty repo-relative path',
            next: `set references[${i}] to a real file path or remove the entry`,
          },
        }],
      };
    }
    // aspect-reference-escape
    if (escapesRepo(normalized)) {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reference-escape',
          messageData: {
            what: `Aspect '${aspectId}' reference '${rawPath}' escapes the repository root.`,
            why: 'references must be repo-relative so they are reproducible across clones and CI.',
            next: `use a path relative to the repository root, e.g. 'docs/error-codes.md'.`,
          },
        }],
      };
    }
    // aspect-reference-duplicate
    if (seenPaths.has(normalized)) {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reference-duplicate',
          messageData: {
            what: `Aspect '${aspectId}' lists '${normalized}' more than once under 'references:'.`,
            why: 'duplicate references inflate the prompt and indicate a copy-paste error.',
            next: `remove the duplicate entry from .yggdrasil/aspects/${aspectId}/yg-aspect.yaml.`,
          },
        }],
      };
    }
    seenPaths.add(normalized);
    references.push({ path: normalized, description });
  }
  return { ok: true, value: references };
}

export async function parseAspect(
  aspectDir: string,
  aspectYamlPath: string,
  id: string,
  options: ParseAspectOptions = {},
): Promise<ParseAspectResult> {
  const idTrimmed = id?.trim() ?? '';
  if (!idTrimmed) {
    return {
      ok: false,
      aspectId: id ?? '',
      errors: [{
        code: 'aspect-invalid-id',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: aspect id is empty`,
          why: 'aspect id must be the relative path under aspects/',
          next: 'rename the parent directory to match the intended aspect id',
        },
      }],
    };
  }
  const refused = (errors: FieldErrors): ParseAspectResult => ({ ok: false, aspectId: idTrimmed, errors });

  const rawBaseResult = await readAspectYaml(aspectYamlPath, idTrimmed, options);
  if (!rawBaseResult.ok) return refused(rawBaseResult.errors);
  const rawBase = rawBaseResult.value;

  // The consumer's adaptation, merged over the rule's own definition BEFORE any
  // of it is validated. Doing it here — rather than patching an AspectDef
  // afterwards — is what makes an adapted value indistinguishable from one the
  // rule declared itself: every check below, and every message it can produce,
  // sees exactly one definition.
  const adaptFilePath = path.join(aspectDir, ADAPT_FILENAME);
  const adaptResult = await parseAspectAdapt(aspectDir, idTrimmed);
  if (!adaptResult.ok) {
    return refused([{ code: adaptResult.code, messageData: adaptResult.messageData }]);
  }
  const adapt = adaptResult.value;
  const raw = adapt.present
    ? completeAdaptedBlocks(rawBase, adapt.keys, mergeAdaptOverAspect(rawBase, adapt.keys), aspectDir, idTrimmed)
    : rawBase;
  // Where a refusal about a block the adaptation set should send the reader:
  // the adaptation, which is theirs to edit, not the package's copy, which is not.
  const adaptSets = (key: string): boolean => adapt.present && Object.prototype.hasOwnProperty.call(adapt.keys, key);

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    return refused([{
      code: 'aspect-name-missing',
      messageData: {
        what: `yg-aspect.yaml at ${aspectYamlPath}: missing or empty 'name'`,
        why: 'every aspect must declare a name',
        next: 'add `name: <YourAspectName>` to the file',
      },
    }]);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  const kindResult = inferRuleKind(raw, aspectDir, idTrimmed, options, adaptSets('reviewer') ? adaptFilePath : undefined);
  if (!kindResult.ok) return refused(kindResult.errors);
  const { reviewer, hasCompanionMjs } = kindResult.value;

  // companion: is resolved before the rule's sources: a companion named outside
  // the rule directory runs in place of companion.mjs, so the modules it imports
  // are verdict inputs exactly like a companion.mjs helper's.
  let companion: { path: string; source: string } | undefined;
  if (raw.companion !== undefined) {
    const companionResult = await parseCompanion(raw.companion, idTrimmed, aspectDir, options, adapt.present ? adaptFilePath : undefined);
    if (!companionResult.ok) return refused(companionResult.errors);
    companion = companionResult.value;
  }
  const companionPath = companion?.path;

  const sourcesResult = await readRuleSources(aspectDir, idTrimmed, options, companionPath);
  if (!sourcesResult.ok) return refused(sourcesResult.errors);
  const { artifacts, supportFiles } = sourcesResult.value;

  const labelsResult = parseRuleLabels(raw, idTrimmed, aspectDir);
  if (!labelsResult.ok) return refused(labelsResult.errors);
  const { status, reviewBy, errs } = labelsResult.value;

  const impliesResult = raw.implies !== undefined
    ? parseImplies(raw.implies, idTrimmed, aspectYamlPath, aspectDir, options.package)
    : { ok: true as const, value: {} as ParsedImplies };
  if (!impliesResult.ok) return refused(impliesResult.errors);
  const { implies, impliesWhens, impliesStatusInherit } = impliesResult.value;

  let when: WhenPredicate | undefined;
  if (raw.when !== undefined) {
    const whenResult = parseAspectWhen(raw.when, aspectYamlPath);
    if (!whenResult.ok) return refused(whenResult.errors);
    when = whenResult.value;
  }

  // references: optional, normalized to Array<{ path, description? }>
  let references: Array<{ path: string; description?: string }> | undefined;
  if (raw.references !== undefined) {
    const referencesResult = parseReferences(raw.references, reviewer.type, idTrimmed, aspectYamlPath, options.package !== undefined ? adaptFilePath : undefined);
    if (!referencesResult.ok) return refused(referencesResult.errors);
    references = referencesResult.value;
  }

  // scope: — optional review granularity block
  let scope: ScopeDef | undefined;
  if (raw.scope !== undefined) {
    const scopeResult = parseScope(raw.scope, idTrimmed, aspectYamlPath, reviewer.type, adaptSets('scope') ? adaptFilePath : undefined);
    if (!scopeResult.ok) return refused(scopeResult.errors);
    scope = scopeResult.value;
  }

  const configResult = resolveRuleConfig(raw, idTrimmed, options, adapt.present ? adaptFilePath : aspectYamlPath);
  if (!configResult.ok) return refused(configResult.errors);
  const config = configResult.value;

  const schemaResult = schemaFloor(raw, idTrimmed, adapt.present ? `${aspectYamlPath} (with ${adaptFilePath})` : aspectYamlPath);
  if (!schemaResult.ok) return refused(schemaResult.errors);

  // An externally-named companion joins the aspect's artifacts under the name the
  // rest of the system already looks for. That is what keeps the verdict honest:
  // the companion hash is taken from the artifacts, so an edit to YOUR module
  // invalidates the verdicts it helped produce, exactly as an edit to a packaged
  // companion.mjs would.
  const allArtifacts = companion === undefined
    ? artifacts
    : [...artifacts.filter((a) => a.filename !== 'companion.mjs'), { filename: 'companion.mjs', content: companion.source }]
        .sort((a, b) => a.filename.localeCompare(b.filename));

  return {
    ok: true,
    aspect: {
      name: (raw.name as string).trim(),
      id: idTrimmed,
      description,
      reviewer,
      implies,
      ...(impliesWhens && { impliesWhens }),
      ...(impliesStatusInherit && { impliesStatusInherit }),
      ...(when && { when }),
      artifacts: allArtifacts,
      ...(references && { references }),
      ...(Object.keys(config).length > 0 && { config }),
      ...(companionPath !== undefined && { companionPath }),
      ...(status !== undefined && { status }),
      ...(reviewBy !== undefined && { reviewBy }),
      ...(errs !== undefined && { errs }),
      // Type-checked by the schema floor above (a non-boolean is refused there).
      ...(raw.stores_content === false && { storesContent: false as const }),
      ...(scope !== undefined && { scope }),
      ...((hasCompanionMjs || companionPath !== undefined) && { hasCompanion: true }),
      ...(supportFiles.length > 0 && { supportFiles }),
    },
  };
}

/**
 * The schema's floor under the field checks: a value of the wrong type none of
 * them looks at (a description that is a list, a reference description that is
 * a number) would otherwise be dropped without a word. Run over the definition
 * as it is enforced — the rule's own file with any adaptation merged in.
 */
function schemaFloor(raw: Record<string, unknown>, idTrimmed: string, where: string): FieldResult<null> {
  const problems = schemaProblems(raw, ASPECT_ROOT);
  if (problems.length === 0) return { ok: true, value: null };
  return fieldRefusal('aspect-field-invalid', {
    what: `yg-aspect.yaml at ${where}: ${problems[0].message}`,
    why: `Rule '${idTrimmed}' is not loaded until the value is corrected: a value of the wrong type would be ignored, so the rule would run differently from what its file says.`,
    next: `Correct '${problems[0].where}' (yg schemas read aspect gives each key's type).`,
  });
}

/** The refusals a field parse can end in, in the parser's one error shape. */
type FieldErrors = Array<{ code: CheckCode; messageData: IssueMessage }>;

/** A field parse: its value, or the refusals it ends in. */
type FieldResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

/** One refusal, as a failed field parse. */
function fieldRefusal(code: CheckCode, messageData: IssueMessage): { ok: false; errors: FieldErrors } {
  return { ok: false, errors: [{ code, messageData }] };
}

/**
 * The rule's kind, from its `reviewer:` block or — when that is absent — from the
 * rule files beside it.
 *
 * Rule-file presence drives kind inference when `reviewer:` is absent. The
 * parser knows the aspect directory, so it can detect sibling content.md /
 * check.mjs. `hasImplies` is a coarse check (non-empty array) — the full
 * implies parse happens later; here we only need it to recognize an
 * aggregating aspect (neither file + implies).
 * A rule made of symlinks is refused before anything reads it: the readers
 * below disagree about links (presence checks follow them, the artifact and
 * support-file readers skip them), so a linked content.md was reviewed as an
 * empty rule and a linked check.mjs ran code its hash never saw.
 */
function inferRuleKind(
  raw: Record<string, unknown>,
  aspectDir: string,
  idTrimmed: string,
  options: ParseAspectOptions,
  adaptFilePath?: string,
): FieldResult<{ reviewer: AspectReviewerSpec; hasCompanionMjs: boolean }> {
  const linked = ruleDirSymlinks(aspectDir);
  if (linked.length > 0) {
    return fieldRefusal('aspect-source-symlink', aspectSourceSymlinkMessage(idTrimmed, linked.map((l) => `${toPosixPath(path.relative(options.projectRoot ?? deriveProjectRoot(aspectDir, idTrimmed), path.join(aspectDir, l)))}`)));
  }

  const hasContentMd = fileExistsSync(path.join(aspectDir, 'content.md'));
  const hasCheckMjs = fileExistsSync(path.join(aspectDir, 'check.mjs'));
  const hasCompanionMjs = fileExistsSync(path.join(aspectDir, 'companion.mjs'));
  const hasImplies = Array.isArray(raw.implies) && raw.implies.length > 0;

  const reviewerResult = parseReviewer(raw.reviewer, idTrimmed, { hasContentMd, hasCheckMjs, hasImplies });
  if (!reviewerResult.ok) {
    if (adaptFilePath === undefined) return reviewerResult;
    // The adaptation set reviewer:, so a refusal of the merged block is most
    // likely about what it set: say where, so the reader edits the adaptation
    // rather than the package's copy, which any edit to is refused.
    return {
      ok: false,
      errors: reviewerResult.errors.map((e) => ({
        ...e,
        messageData: { ...e.messageData, what: `${e.messageData.what} (reviewer: as adapted by ${adaptFilePath})` },
      })),
    };
  }
  return { ok: true, value: { reviewer: reviewerResult.value, hasCompanionMjs } };
}

/**
 * Complete a `reviewer:` or `scope:` block an adaptation brought in over a rule
 * that declares none, before anything validates it.
 *
 * The merge is key by key, so an adaptation that sets only `reviewer.tier`
 * over a rule whose kind is inferred (no `reviewer:` block), or only
 * `scope.files` over a rule with no `scope:`, would leave a block missing the
 * key the validator requires — `type` or `per` — and the adapted rule would be
 * refused for a fact that is not the consumer's to state. So the missing key
 * is filled with what the rule already means: the kind its rule files give it,
 * and the default `per: node`. A block the rule itself declares is left alone:
 * a rule that writes `reviewer:` without `type:` is the package's own error.
 */
function completeAdaptedBlocks(
  base: Record<string, unknown>,
  adapt: Record<string, unknown>,
  merged: Record<string, unknown>,
  aspectDir: string,
  idTrimmed: string,
): Record<string, unknown> {
  const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const absent = (v: unknown): boolean => v === undefined || v === null;
  const out = { ...merged };
  if (isMap(adapt.reviewer) && absent(base.reviewer) && isMap(out.reviewer) && !('type' in out.reviewer)) {
    const inferred = parseReviewer(undefined, idTrimmed, {
      hasContentMd: fileExistsSync(path.join(aspectDir, 'content.md')),
      hasCheckMjs: fileExistsSync(path.join(aspectDir, 'check.mjs')),
      hasImplies: Array.isArray(base.implies) && base.implies.length > 0,
    });
    if (inferred.ok) out.reviewer = { type: inferred.value.type, ...out.reviewer };
  }
  if (isMap(adapt.scope) && absent(base.scope) && isMap(out.scope) && !('per' in out.scope)) {
    out.scope = { per: 'node', ...out.scope };
  }
  return out;
}

/**
 * config: — the values this rule's check.mjs / companion.mjs will read through
 * ctx.config. The package declares the keys and their defaults; the adapt
 * overrides the ones this repository wants different. Resolved here so the rest
 * of the system sees one settled record and never has to consult two sources.
 * `configFilePath` is the file a refusal names: the adaptation when there is
 * one, the rule's own file otherwise.
 */
function resolveRuleConfig(
  raw: Record<string, unknown>,
  idTrimmed: string,
  options: ParseAspectOptions,
  configFilePath: string,
): FieldResult<Record<string, string | number | boolean>> {
  const configResult = resolveAspectConfig(
    options.package?.configSchema ?? {},
    raw.config,
    {
      aspectId: options.package?.relativeId ?? idTrimmed,
      packageName: options.package?.packageName,
      adaptFilePath: configFilePath,
    },
  );
  if (!configResult.ok) return fieldRefusal(configResult.code, configResult.messageData);
  return { ok: true, value: configResult.value };
}

/**
 * Read the rule's own yg-aspect.yaml: a YAML mapping with only accepted keys.
 *
 * A key the rule's own file does not declare is refused by name: a misspelled
 * `stauts:` would otherwise load the rule at its default status — enforced —
 * and a misspelled `scope:` or `when:` would widen it, all without a word.
 * Checked on the rule's own file, before the adaptation is merged in: the
 * adaptation refuses its own unknown keys, against its own narrower list.
 */
async function readAspectYaml(
  aspectYamlPath: string,
  idTrimmed: string,
  options: ParseAspectOptions,
): Promise<FieldResult<Record<string, unknown>>> {
  const content = await readFile(aspectYamlPath, 'utf-8');
  // A syntax error is refused like any other malformed rule file: a throw here
  // would abort the whole graph load instead of naming the one rule to fix.
  let rawBase: Record<string, unknown>;
  try {
    rawBase = parseYaml(content) as Record<string, unknown>;
  } catch (err) {
    return fieldRefusal('yaml-invalid', {
      what: `yg-aspect.yaml at ${aspectYamlPath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      why: `Rule '${idTrimmed}' is not loaded until the file parses: nothing it says can be read.`,
      next: `Fix the YAML syntax in ${aspectYamlPath}.`,
    });
  }

  if (!rawBase || typeof rawBase !== 'object' || Array.isArray(rawBase)) {
    return fieldRefusal('yaml-invalid', {
      what: `yg-aspect.yaml at ${aspectYamlPath}: file is empty or not a YAML mapping`,
      why: 'aspect definitions must be a YAML mapping',
      next: 'add a valid YAML mapping (name, description, reviewer, etc.)',
    });
  }

  const unknownAspectKeys = findUnknownKeys(rawBase, ASPECT_KEYS, RETIRED_ASPECT_KEYS);
  if (unknownAspectKeys.length > 0) {
    const relYaml = options.package !== undefined ? `the installed copy of '${options.package.relativeId}' from package '${options.package.packageName}'` : aspectYamlPath;
    return fieldRefusal('aspect-unknown-key', {
      what: `yg-aspect.yaml at ${aspectYamlPath}: ${describeUnknownKeys('', unknownAspectKeys, ASPECT_KEYS)}`,
      why: `Rule '${idTrimmed}' is not loaded until the key is corrected: loading it without the key would run the rule differently from what its file says.`,
      next: options.package !== undefined
        ? `The file is ${relYaml}, which is not yours to edit. Ask the package author for a version without the key, or check that this Yggdrasil satisfies the package's requires.yg — a key from a newer release is unknown to an older one.`
        : unknownAspectKeys[0].retired !== undefined
          ? `Delete '${unknownAspectKeys[0].key}' from ${aspectYamlPath}.`
        : unknownAspectKeys[0].suggestion !== undefined
          ? `Rename '${unknownAspectKeys[0].key}' to '${unknownAspectKeys[0].suggestion}' in ${aspectYamlPath}, or remove it (yg schemas read aspect lists the accepted keys).`
          : `Remove '${unknownAspectKeys[0].key}' from ${aspectYamlPath}, or rename it to an accepted key (yg schemas read aspect lists them).`,
    });
  }
  return { ok: true, value: rawBase };
}

/**
 * The rule's artifacts and support files — every verdict input its directory holds.
 *
 * The adapt file is excluded from artifacts alongside yg-aspect.yaml. Artifacts
 * ARE the rule's content — content.md / check.mjs / companion.mjs are read from
 * here and hashed into the verdict — and the consumer's own adaptation is not
 * part of what the package published. Left in, it would ride into the rule hash
 * and make every adapted rule look like a different rule.
 */
async function readRuleSources(
  aspectDir: string,
  idTrimmed: string,
  options: ParseAspectOptions,
  companionPath: string | undefined,
): Promise<FieldResult<{ artifacts: AspectDef['artifacts']; supportFiles: NonNullable<AspectDef['supportFiles']> }>> {
  const artifacts = await readArtifacts(aspectDir, ['yg-aspect.yaml', ADAPT_FILENAME, ADAPT_LOG_FILENAME]);
  // Everything else the rule's code can reach — a helper module, a shipped table
  // — is a verdict input too. See readSupportFileHashes for what is left out.
  const projectRootForRule = options.projectRoot ?? deriveProjectRoot(aspectDir, idTrimmed);
  // A companion named by `companion:` (repo-relative) is traced like companion.mjs:
  // an edit to a module it imports re-opens the verdicts it helped produce.
  const entryPoints = companionPath === undefined
    ? []
    : [toPosixPath(path.relative(aspectDir, path.resolve(projectRootForRule, companionPath)))];
  const support = await readSupportFileHashes(
    aspectDir,
    ['yg-aspect.yaml', ADAPT_FILENAME, ADAPT_LOG_FILENAME, 'log.md', 'provenance.json', 'content.md', 'check.mjs', 'companion.mjs'],
    projectRootForRule,
    entryPoints,
  );
  // A symbolic link the rule's code names — under drills/, in a nested rule's
  // directory, through a linked dot-named directory — is refused like a linked
  // file beside the rule: following it would fold bytes from wherever it points.
  if (support.linked.length > 0) {
    return fieldRefusal('aspect-source-symlink', aspectSourceSymlinkMessage(idTrimmed, support.linked.map((l) => `${toPosixPath(path.relative(projectRootForRule, path.join(aspectDir, l)))}`)));
  }
  return { ok: true, value: { artifacts, supportFiles: support.files } };
}

/**
 * The three labels a rule carries about itself — `status:`, `review_by:` and
 * `errs:` — each optional and strict when present.
 */
function parseRuleLabels(
  raw: Record<string, unknown>,
  idTrimmed: string,
  aspectDir: string,
): FieldResult<{ status?: AspectStatus; reviewBy?: string; errs?: ErrsDirection }> {
  let status: AspectStatus | undefined;
  if (raw.status !== undefined) {
    if (
      typeof raw.status !== 'string' ||
      !ASPECT_STATUS_VALUES.includes(raw.status as AspectStatus)
    ) {
      return fieldRefusal('aspect-status-invalid', aspectStatusInvalidMessage({
        aspectId: idTrimmed,
        value: String(raw.status),
        aspectDir,
      }));
    }
    status = raw.status as AspectStatus;
  }

  // review_by: — optional standing review-by date (bare ISO `YYYY-MM-DD`).
  // Presence-gated and strict when present (mirrors the status block above): a
  // malformed date must NOT silently never-fire, so a present-but-invalid value
  // is the blocking parse error aspect-review-by-malformed via the same errors
  // path aspect-status-invalid uses. Valid on ANY aspect kind — review cadence is
  // independent of reviewer kind, so no cross-field check downstream. NEVER a hash
  // ingredient (the pair-hash builders do not read reviewBy).
  let reviewBy: string | undefined;
  if (raw.review_by !== undefined) {
    if (typeof raw.review_by !== 'string' || !isValidReviewByDate(raw.review_by)) {
      return fieldRefusal('aspect-review-by-malformed', aspectReviewByMalformedMessage({
        aspectId: idTrimmed,
        value: String(raw.review_by),
        aspectDir,
      }));
    }
    reviewBy = raw.review_by;
  }

  // errs: — optional deterministic-check error-direction label. Strict when
  // present: accept ONLY the three literals here; whether errs is legal on THIS
  // aspect's reviewer kind is a cross-field contract enforced downstream
  // (checkAspectErrsDirection), so a valid literal on an LLM/aggregate aspect is
  // tolerated by the parser and flagged by the validator. NEVER a hash ingredient.
  let errs: ErrsDirection | undefined;
  if (raw.errs !== undefined) {
    if (typeof raw.errs !== 'string' || !ERRS_DIRECTION_VALUES.includes(raw.errs as ErrsDirection)) {
      return fieldRefusal('aspect-errs-invalid', {
        what: `Aspect '${idTrimmed}' declares errs: '${String(raw.errs)}' (not a valid value).`,
        why: 'errs must be one of: over, under, exact.',
        next: `Edit .yggdrasil/aspects/${idTrimmed}/yg-aspect.yaml and set errs to one of over|under|exact, or remove the field — yg schemas read aspect describes what each value means.`,
      });
    }
    errs = raw.errs as ErrsDirection;
  }
  return { ok: true, value: { status, reviewBy, errs } };
}

/** The parsed `implies:` block: target ids in order, and each edge's own when / status_inherit. */
interface ParsedImplies {
  implies?: string[];
  impliesWhens?: Record<string, WhenPredicate>;
  impliesStatusInherit?: Record<string, StatusInherit>;
}

/** Parse the `implies:` block (present): an array of attachment entries. */
function parseImplies(
  rawImplies: unknown,
  idTrimmed: string,
  aspectYamlPath: string,
  aspectDir: string,
  pkg: AspectPackageContext | undefined,
): FieldResult<ParsedImplies> {
  if (!Array.isArray(rawImplies)) {
    return fieldRefusal('aspect-implies-not-array', {
      what: `yg-aspect.yaml at ${aspectYamlPath}: 'implies' must be an array`,
      why: 'implies declares dependent aspects as a list',
      next: 'replace value with [aspect-id-1, aspect-id-2, ...]',
    });
  }
  const implies: string[] = [];
  let impliesWhens: Record<string, WhenPredicate> | undefined;
  let impliesStatusInherit: Record<string, StatusInherit> | undefined;
  for (let i = 0; i < rawImplies.length; i++) {
    let parsed;
    try {
      parsed = parseAspectAttachment(
        rawImplies[i],
        `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}]`,
        'implies-edge',
      );
    } catch (err) {
      return impliesEntryRefusal(err, rawImplies[i], i, idTrimmed, aspectYamlPath, aspectDir);
    }
    // Inside a package, an implies target is written RELATIVE — the package
    // author cannot know the install path, and an id they hard-coded would break
    // the moment a consumer installed under a different identity. The install
    // prefix is applied here, so everything downstream (the implied-aspect
    // existence check, the implies-cycle check) works on real installed ids.
    let targetId = parsed.id;
    if (pkg !== undefined) {
      const target = packageImpliesTarget(parsed.id, i, pkg);
      if (!target.ok) return target;
      targetId = target.value;
    }
    implies.push(targetId);
    if (parsed.when) {
      (impliesWhens ??= {})[targetId] = parsed.when;
    }
    if (parsed.statusInherit) {
      (impliesStatusInherit ??= {})[targetId] = parsed.statusInherit;
    }
  }
  return { ok: true, value: { implies, impliesWhens, impliesStatusInherit } };
}

/**
 * The structured refusal for an implies entry parseAspectAttachment threw on.
 * parseAspect's contract is a {ok}|{ok:false,errors} union that never throws for
 * validation: an uncaught throw would escape to the loader and abort the ENTIRE
 * graph load with a generic "this is a bug" message instead of a scoped
 * per-aspect error.
 */
function impliesEntryRefusal(
  err: unknown,
  entry: unknown,
  i: number,
  idTrimmed: string,
  aspectYamlPath: string,
  aspectDir: string,
): { ok: false; errors: FieldErrors } {
  const msg = (err as Error).message;
  if (msg.includes('status_inherit must be one of')) {
    // Reachable only after parseAspectAttachment validated `id`; status_inherit
    // is checked last, so the entry is guaranteed to be an object with a string id.
    const edge = entry as { id: string; status_inherit?: unknown };
    return fieldRefusal('implies-status-inherit-invalid', impliesStatusInheritInvalidMessage({
      implierId: idTrimmed,
      impliedId: edge.id,
      value: String(edge.status_inherit),
      aspectDir,
    }));
  }
  // parseAspectAttachment parses an implies edge's own when: via parseWhen with
  // a ctx suffixed `/when`, so every when-parse failure on the edge carries
  // `/when` in its message — the top-level shape as `.../when: ...` and every
  // nested structural failure as `.../when/relations/...`, `.../when/node/...`,
  // etc. Match the `/when` prefix (NOT the exact `/when:` shape) so a nested
  // typo inside the predicate is routed here too, not thrown. A malformed when:
  // must surface as a structured parse error, not an uncaught throw that the
  // loader surfaces as a non-actionable "file an issue" abort of the whole run.
  if (msg.includes('/when')) {
    return fieldRefusal('aspect-when-invalid', {
      what: `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}] when predicate is invalid: ${msg}`,
      why: 'an implies-edge when: must be a valid node predicate (node/relations/descendants atoms and all_of/any_of/not combinators)',
      next: 'correct the when: predicate — see yg knowledge read conditional-aspects',
    });
  }
  // Any remaining parseAspectAttachment validation failure (missing/blank id,
  // unknown field, wrong entry type) becomes a structured result too — mirroring
  // the top-level when: catch-all.
  return fieldRefusal('aspect-implies-invalid', {
    what: `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}] is invalid: ${msg}`,
    why: 'each implies entry must be an aspect id string, or an object { id, when?, status_inherit? }',
    next: 'fix the implies entry — see yg schemas read aspect',
  });
}

/** A package rule's relative implies target, prefixed with the package's install path. */
function packageImpliesTarget(id: string, i: number, pkg: AspectPackageContext): FieldResult<string> {
  if (id.includes('/')) {
    return fieldRefusal('package-implies-not-relative', {
      what: `Rule '${pkg.relativeId}' in package '${pkg.packageName}' implies '${id}', which is a full path.`,
      why: 'A package is written without knowing where it will be installed, so it names its own rules by their directory name alone. A full path would bind the package to one install location.',
      next: `Change implies[${i}] to just the directory name of the rule inside the package.`,
    });
  }
  if (!pkg.aspectDirs.includes(id)) {
    return fieldRefusal('package-implies-outside-package', {
      what: `Rule '${pkg.relativeId}' in package '${pkg.packageName}' implies '${id}', which is not a rule of that package.`,
      why: 'A package stands on its own: it may bundle its own rules, but it may not depend on a rule from your repository or from another package, which could be absent, renamed, or something else entirely.',
      next: `Remove '${id}' from the implies: of '${pkg.relativeId}', or ask the package author to ship it inside the package.`,
    });
  }
  return { ok: true, value: `${pkg.idPrefix}/${id}` };
}

/**
 * The aspect-level `when:` (present). A malformed one must surface as a
 * structured parse error, NOT propagate as a throw — an uncaught throw here
 * escapes parseAspect (whose contract is a {ok}|{ok:false,errors} union) and is
 * swallowed by the loader, silently dropping this aspect (and any scanned after
 * it) with a clean PASS. A WhenPredicateInvalidError already carries the
 * file-atom cross-hint text; surface it verbatim so the guidance is preserved.
 */
function parseAspectWhen(rawWhen: unknown, aspectYamlPath: string): FieldResult<WhenPredicate> {
  try {
    return { ok: true, value: parseWhen(rawWhen, `yg-aspect.yaml at ${aspectYamlPath}: when`) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // parseWhen embeds the file-atom cross-hint directly in its message text
    // (it throws a plain Error, not a typed class), so detect by content.
    const isFileAtomHint = message.includes('file atom');
    return fieldRefusal('aspect-when-invalid', {
      what: isFileAtomHint
        ? message
        : `yg-aspect.yaml at ${aspectYamlPath}: when predicate is invalid: ${message}`,
      why: isFileAtomHint
        ? 'the aspect-level when: uses the node-predicate grammar (node/relations/descendants atoms); path/content are file atoms and belong in scope.files'
        : 'when: must be a valid node predicate (node/relations/descendants atoms and all_of/any_of/not combinators)',
      next: isFileAtomHint
        ? 'move the file filter to scope.files, or use a node-family atom in when:'
        : 'correct the when: predicate — see yg knowledge read conditional-aspects',
    });
  }
}

/**
 * companion: (present) — an aspect may name its companion module instead of
 * shipping one beside its rule. This is what an adapt uses to point a package's
 * rule at a resolver written HERE: the package cannot know your repository's
 * layout, so the hook that decides which of your files the reviewer should also
 * see has to be yours. The path is repo-relative and must exist NOW, at load
 * time — a companion discovered missing on the first run of the rule would
 * surface as an infrastructure failure in the middle of a review instead of as
 * a graph error. `adaptFilePath` is the adaptation the path came from, if any.
 */
async function parseCompanion(
  rawCompanion: unknown,
  idTrimmed: string,
  aspectDir: string,
  options: ParseAspectOptions,
  adaptFilePath: string | undefined,
): Promise<FieldResult<{ path: string; source: string }>> {
  if (typeof rawCompanion !== 'string' || rawCompanion.trim() === '') {
    return fieldRefusal('aspect-companion-invalid', {
      what: `Aspect '${idTrimmed}' declares companion: '${String(rawCompanion)}', which is not a path.`,
      why: 'companion: names one repository-relative module file that resolves the extra files a reviewer should see.',
      next: `Set companion: to a repo-relative path such as 'tools/my-companion.mjs', or remove the key.`,
    });
  }
  const normalized = toPosixPath(rawCompanion.trim());
  if (escapesRepo(normalized)) {
    return fieldRefusal('aspect-companion-escape', {
      what: `Aspect '${idTrimmed}' declares companion: '${rawCompanion}', which leaves the repository root.`,
      why: 'A companion runs on every check; one living outside the repository would make the result depend on a file no clone and no CI runner has.',
      next: `Move the module inside the repository and give companion: a repo-relative path.`,
    });
  }
  const root = options.projectRoot ?? deriveProjectRoot(aspectDir, idTrimmed);
  const linkedCompanion = symlinkOnPath(root, normalized);
  if (linkedCompanion !== null) {
    return fieldRefusal('aspect-source-symlink', aspectSourceSymlinkMessage(idTrimmed, [toPosixPath(linkedCompanion)]));
  }
  try {
    return { ok: true, value: { path: normalized, source: await readFile(path.resolve(root, normalized), 'utf-8') } };
  } catch {
    return fieldRefusal('aspect-companion-missing', {
      what: `Aspect '${idTrimmed}' declares companion: '${normalized}', but there is no readable file there.`,
      why: 'The companion is loaded on every review this rule produces; a missing one would stop the rule mid-run rather than at load.',
      next: `Create ${normalized}, or correct the companion: path${adaptFilePath !== undefined ? ` in ${adaptFilePath}` : ''}.`,
    });
  }
}

interface RuleFileFacts {
  hasContentMd: boolean;
  hasCheckMjs: boolean;
  hasImplies: boolean;
}

function parseReviewer(
  raw: unknown,
  aspectId: string,
  files: RuleFileFacts,
):
  | { ok: true; value: AspectReviewerSpec }
  | { ok: false; errors: Array<{ code: CheckCode; messageData: IssueMessage }> }
{
  // Step 1: structural — when `reviewer:` is absent or null, INFER the kind from
  // rule-file presence. This is the single inference point; the validator
  // (checkAspectRuleSources) is the authority on file/type agreement once an
  // aspect carries a populated reviewer.type.
  //   - content.md present (no check.mjs)  → llm
  //   - check.mjs present (no content.md)  → deterministic
  //   - neither file, has implies          → aggregate (no own reviewer/verdict)
  //   - neither file, no implies           → error (an aspect that does nothing)
  //   - both files                         → cannot infer intent; defer the
  //                                           mutual-exclusion verdict to the
  //                                           validator, but error here because
  //                                           the parser cannot pick a type.
  if (raw === undefined || raw === null) {
    if (files.hasContentMd && !files.hasCheckMjs) {
      return { ok: true, value: { type: 'llm' } };
    }
    if (files.hasCheckMjs && !files.hasContentMd) {
      return { ok: true, value: { type: 'deterministic' } };
    }
    if (!files.hasContentMd && !files.hasCheckMjs && files.hasImplies) {
      return { ok: true, value: { type: 'aggregate' } };
    }
    return {
      ok: false,
      errors: [{
        code: 'aspect-rule-source-missing',
        messageData: {
          what: `Aspect '${aspectId}' has no rule source to infer its kind from: no content.md, no check.mjs, and no implies:.`,
          why: 'A rule\'s kind comes from what it ships — content.md makes a reviewer rule, check.mjs a script rule, implies: a bundle. With none of them it does nothing.',
          next: `Add content.md (a reviewer rule) or check.mjs (a script rule) to .yggdrasil/aspects/${aspectId}/, or declare implies: to make it a bundle.`,
        },
      }],
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-reviewer-not-mapping',
        messageData: {
          what: `Aspect '${aspectId}' has a reviewer: value that is not a YAML mapping.`,
          why: 'reviewer: accepts a mapping with type: and an optional tier:.',
          next: 'Write it as a mapping — `reviewer: { type: llm }` — or remove it: the kind is inferred from the rule source.',
        },
      }],
    };
  }

  // Step 2+3: collect independent errors on the mapping
  const errors: Array<{ code: CheckCode; messageData: IssueMessage }> = [];
  const obj = raw as Record<string, unknown>;

  // Step 2: structural — type missing or invalid
  let typeValid = false;
  if (!('type' in obj)) {
    errors.push({
      code: 'aspect-reviewer-type-missing',
      messageData: {
        what: `aspect '${aspectId}' has reviewer: mapping without type:`,
        why: 'type: distinguishes reviewer rules (llm) from script rules (deterministic)',
        next: 'add `type: llm` or `type: deterministic` under reviewer:',
      },
    });
  } else if (obj.type !== 'llm' && obj.type !== 'deterministic' && obj.type !== 'aggregate') {
    errors.push({
      code: 'aspect-reviewer-type-invalid',
      messageData: {
        what: `aspect '${aspectId}' has invalid reviewer.type: '${String(obj.type)}'`,
        why: 'only "llm", "deterministic", or "aggregate" are valid',
        next: 'change to type: llm, type: deterministic, or type: aggregate',
      },
    });
  } else {
    typeValid = true;
  }

  // Step 3: unknown keys — INDEPENDENT of type presence/validity
  const allowedKeys = new Set(keysOf(ASPECT_REVIEWER));
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      errors.push({
        code: 'aspect-reviewer-unknown-key',
        messageData: {
          what: `aspect '${aspectId}' has unknown reviewer key '${k}'`,
          why: 'reviewer: accepts only `type` and `tier`',
          next: 'remove the unknown key (provider/model lives in the config tier, not the aspect)',
        },
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Step 4: cross-field — only when type is valid
  if (!typeValid) return { ok: false, errors }; // unreachable but type-safe

  const type = obj.type as 'llm' | 'deterministic' | 'aggregate';
  if (obj.tier !== undefined) {
    if (typeof obj.tier !== 'string' || obj.tier.trim() === '') {
      return {
        ok: false,
        errors: [{
          code: 'aspect-reviewer-tier-invalid',
          messageData: {
            what: `aspect '${aspectId}' has empty or non-string reviewer.tier`,
            why: 'tier must be a non-empty string matching a tier name in yg-config.yaml',
            next: 'set tier: <name> or remove the field to use the default',
          },
        }],
      };
    }
    // A tier names an LLM reviewer configuration, so it is only meaningful on an
    // LLM aspect. Deterministic aspects run locally with no reviewer; aggregate
    // aspects have no own reviewer at all — a tier on either is a contradiction.
    if (type === 'deterministic' || type === 'aggregate') {
      return {
        ok: false,
        errors: [{
          code: type === 'deterministic' ? 'aspect-tier-on-deterministic' : 'aspect-tier-on-aggregate',
          messageData: {
            what: `aspect '${aspectId}' has reviewer.type: ${type} together with reviewer.tier: '${obj.tier}'`,
            why: type === 'deterministic'
              ? 'Script rules run locally without a reviewer; tiers do not apply'
              : 'A bundle has no reviewer of its own; a tier does not apply',
            next: 'remove tier: from the aspect',
          },
        }],
      };
    }
    return { ok: true, value: { type, tier: obj.tier as string } };
  }
  return { ok: true, value: { type } };
}

/**
 * Parse the `scope:` block from a yg-aspect.yaml.
 *
 * Contract:
 *   - Must be a YAML mapping.
 *   - `per:` is REQUIRED — must be 'node' or 'file'. Any other value → aspect-scope-invalid.
 *   - `files:` is optional — parsed via parseFileWhen (file-when grammar: path/content atoms).
 *     A WhenPredicateInvalidError (or any parse failure) surfaces as aspect-scope-invalid.
 *   - Unknown keys → aspect-scope-invalid.
 *   - scope on an aggregate aspect → aspect-scope-on-aggregate.
 */
function parseScope(
  rawScope: unknown,
  aspectId: string,
  aspectYamlPath: string,
  reviewerType: 'llm' | 'deterministic' | 'aggregate',
  adaptFilePath?: string,
):
  | { ok: true; value: ScopeDef }
  | { ok: false; errors: Array<{ code: CheckCode; messageData: IssueMessage }> }
{
  // When the adaptation set scope:, every refusal names it as the file to edit:
  // the package's copy of yg-aspect.yaml is not the consumer's to change.
  const at = adaptFilePath === undefined
    ? `yg-aspect.yaml at ${aspectYamlPath}`
    : `${adaptFilePath} (adapting ${aspectYamlPath})`;
  const editFile = adaptFilePath ?? `.yggdrasil/aspects/${aspectId}/yg-aspect.yaml`;
  // scope on aggregate is forbidden — checked before any structural parsing
  if (reviewerType === 'aggregate') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-on-aggregate',
        messageData: {
          what: `Aspect '${aspectId}' declares 'scope:' but it is a bundle (no content.md, no check.mjs).`,
          why: 'A bundle has no rule source and no verdict of its own — scope controls review granularity for a rule source, so it has no meaning here.',
          next: `Remove 'scope:' from ${editFile}, or add content.md / check.mjs to make this a reviewer rule or a script rule.`,
        },
      }],
    };
  }

  // scope must be a mapping
  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-invalid',
        messageData: {
          what: `${at}: 'scope' must be a YAML mapping`,
          why: "scope controls review granularity — it must be an object with 'per:' and optional 'files:'",
          next: "Write scope: as a mapping — `scope: { per: node }`, or `scope: { per: file }` with an optional files: filter.",
        },
      }],
    };
  }

  const obj = rawScope as Record<string, unknown>;

  // Reject unknown keys (only 'per' and 'files' are allowed)
  const ALLOWED_SCOPE_KEYS = new Set(keysOf(ASPECT_SCOPE));
  const unknownScopeKeys = Object.keys(obj).filter(k => !ALLOWED_SCOPE_KEYS.has(k));
  if (unknownScopeKeys.length > 0) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-invalid',
        messageData: {
          what: `${at}: unknown key '${unknownScopeKeys[0]}' in scope`,
          why: "scope accepts only 'per' and 'files'",
          next: `remove '${unknownScopeKeys[0]}' from the scope block`,
        },
      }],
    };
  }

  // per: is REQUIRED
  if (!('per' in obj)) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-invalid',
        messageData: {
          what: `${at}: 'scope' block is missing required 'per:' field`,
          why: "'per' determines review granularity — allowed values: node | file",
          next: "add 'per: node' or 'per: file' under scope:",
        },
      }],
    };
  }

  if (obj.per !== 'node' && obj.per !== 'file') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-invalid',
        messageData: {
          what: `${at}: invalid scope.per value '${String(obj.per)}'`,
          why: "allowed values for scope.per are: node | file",
          next: "change scope.per to 'node' or 'file'",
        },
      }],
    };
  }

  const per = obj.per as 'node' | 'file';

  // files: is optional; parse via file-when grammar
  let files: ScopeDef['files'];
  if ('files' in obj && obj.files !== undefined) {
    try {
      files = parseFileWhen(obj.files, `${at}: scope.files`, 'scope.files');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Augment: if the error is a WhenPredicateInvalidError whose message already carries
      // the cross-hint text ("node atom"), surface it as-is so the hint text is preserved.
      const isNodeAtomHint = err instanceof WhenPredicateInvalidError && message.includes('node atom');
      return {
        ok: false,
        errors: [{
          code: 'aspect-scope-invalid',
          messageData: {
            what: isNodeAtomHint
              ? message
              : `${at}: scope.files predicate is invalid: ${message}`,
            why: isNodeAtomHint
              ? 'scope.files uses the file-predicate grammar (path/content atoms); node-family atoms belong in when:'
              : 'scope.files must be a valid file predicate (path/content atoms and all_of/any_of/not combinators)',
            next: isNodeAtomHint
              ? 'move the node-family filter to the aspect-level when: field'
              : 'correct the scope.files predicate — valid atoms: path (minimatch glob), content (JS regex)',
          },
        }],
      };
    }
  }

  return { ok: true, value: { per, ...(files !== undefined && { files }) } };
}

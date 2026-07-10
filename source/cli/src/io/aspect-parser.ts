import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileExistsSync } from './graph-fs.js';
import type { AspectDef, AspectReviewerSpec, AspectStatus, StatusInherit, ScopeDef, ErrsDirection } from '../model/graph.js';
import { ASPECT_STATUS_VALUES, ERRS_DIRECTION_VALUES } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import type { WhenPredicate } from '../model/when.js';
import { readArtifacts } from './artifact-reader.js';
import { parseWhen, parseAspectAttachment } from '../utils/when-parser.js';
import { parseFileWhen, WhenPredicateInvalidError } from '../utils/file-when-parser.js';
import { aspectStatusInvalidMessage, impliesStatusInheritInvalidMessage } from '../formatters/aspect-status-messages.js';
import { toPosixPath } from '../utils/posix.js';

export type ParseAspectResult =
  | { ok: true; aspect: AspectDef }
  | { ok: false; aspectId: string; errors: Array<{ code: string; messageData: IssueMessage }> };

/** Pure helper: returns true if path p would escape the repository root. */
function escapesRepo(p: string): boolean {
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith('~')) return true;
  let depth = 0;
  for (const segment of p.split('/')) {
    if (segment === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }
  return false;
}

export async function parseAspect(
  aspectDir: string,
  aspectYamlPath: string,
  id: string,
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

  const content = await readFile(aspectYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      aspectId: idTrimmed,
      errors: [{
        code: 'yaml-invalid',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: file is empty or not a YAML mapping`,
          why: 'aspect definitions must be a YAML mapping',
          next: 'add a valid YAML mapping (name, description, reviewer, etc.)',
        },
      }],
    };
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    return {
      ok: false,
      aspectId: idTrimmed,
      errors: [{
        code: 'aspect-name-missing',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: missing or empty 'name'`,
          why: 'every aspect must declare a name',
          next: 'add `name: <YourAspectName>` to the file',
        },
      }],
    };
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  // Rule-file presence drives kind inference when `reviewer:` is absent. The
  // parser knows the aspect directory, so it can detect sibling content.md /
  // check.mjs. `hasImplies` is a coarse check (non-empty array) — the full
  // implies parse happens later; here we only need it to recognize an
  // aggregating aspect (neither file + implies).
  const hasContentMd = fileExistsSync(path.join(aspectDir, 'content.md'));
  const hasCheckMjs = fileExistsSync(path.join(aspectDir, 'check.mjs'));
  const hasCompanionMjs = fileExistsSync(path.join(aspectDir, 'companion.mjs'));
  const hasImplies = Array.isArray(raw.implies) && raw.implies.length > 0;

  const reviewerResult = parseReviewer(raw.reviewer, idTrimmed, { hasContentMd, hasCheckMjs, hasImplies });
  if (!reviewerResult.ok) {
    return { ok: false, aspectId: idTrimmed, errors: reviewerResult.errors };
  }
  const reviewer: AspectReviewerSpec = reviewerResult.value;

  const artifacts = await readArtifacts(aspectDir, ['yg-aspect.yaml']);

  let status: AspectStatus | undefined;
  if (raw.status !== undefined) {
    if (
      typeof raw.status !== 'string' ||
      !ASPECT_STATUS_VALUES.includes(raw.status as AspectStatus)
    ) {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-status-invalid',
          messageData: aspectStatusInvalidMessage({
            aspectId: idTrimmed,
            value: String(raw.status),
            aspectDir,
          }),
        }],
      };
    }
    status = raw.status as AspectStatus;
  }

  // errs: — optional deterministic-check error-direction label. Strict when
  // present: accept ONLY the three literals here; whether errs is legal on THIS
  // aspect's reviewer kind is a cross-field contract enforced downstream
  // (checkAspectErrsDirection), so a valid literal on an LLM/aggregate aspect is
  // tolerated by the parser and flagged by the validator. NEVER a hash ingredient.
  let errs: ErrsDirection | undefined;
  if (raw.errs !== undefined) {
    if (typeof raw.errs !== 'string' || !ERRS_DIRECTION_VALUES.includes(raw.errs as ErrsDirection)) {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-errs-invalid',
          messageData: {
            what: `Aspect '${idTrimmed}' declares errs: '${String(raw.errs)}' (not a valid value).`,
            why: 'errs must be one of: over, under, exact.',
            next: `Edit .yggdrasil/aspects/${idTrimmed}/yg-aspect.yaml and set errs to one of over|under|exact, or remove the field — see .yggdrasil/aspects/README.md, section "errs census".`,
          },
        }],
      };
    }
    errs = raw.errs as ErrsDirection;
  }

  let implies: string[] | undefined;
  let impliesWhens: Record<string, WhenPredicate> | undefined;
  let impliesStatusInherit: Record<string, StatusInherit> | undefined;
  if (raw.implies !== undefined) {
    if (!Array.isArray(raw.implies)) {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-implies-not-array',
          messageData: {
            what: `yg-aspect.yaml at ${aspectYamlPath}: 'implies' must be an array`,
            why: 'implies declares dependent aspects as a list',
            next: 'replace value with [aspect-id-1, aspect-id-2, ...]',
          },
        }],
      };
    }
    implies = [];
    for (let i = 0; i < raw.implies.length; i++) {
      let parsed;
      try {
        parsed = parseAspectAttachment(
          raw.implies[i],
          `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}]`,
          'implies-edge',
        );
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('status_inherit must be one of')) {
          // Reachable only after parseAspectAttachment validated `id`; status_inherit
          // is checked last, so the entry is guaranteed to be an object with a string id.
          const entry = raw.implies[i] as { id: string; status_inherit?: unknown };
          return {
            ok: false,
            aspectId: idTrimmed,
            errors: [{
              code: 'implies-status-inherit-invalid',
              messageData: impliesStatusInheritInvalidMessage({
                implierId: idTrimmed,
                impliedId: entry.id,
                value: String(entry.status_inherit),
                aspectDir,
              }),
            }],
          };
        }
        throw err;
      }
      implies.push(parsed.id);
      if (parsed.when) {
        (impliesWhens ??= {})[parsed.id] = parsed.when;
      }
      if (parsed.statusInherit) {
        (impliesStatusInherit ??= {})[parsed.id] = parsed.statusInherit;
      }
    }
  }

  let when: WhenPredicate | undefined;
  if (raw.when !== undefined) {
    when = parseWhen(raw.when, `yg-aspect.yaml at ${aspectYamlPath}: when`);
  }

  // references: optional, normalized to Array<{ path, description? }>
  let references: Array<{ path: string; description?: string }> | undefined;
  if (raw.references !== undefined) {
    if (!Array.isArray(raw.references)) {
      return {
        ok: false,
        aspectId: idTrimmed,
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
    if (reviewer.type === 'deterministic') {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-references-on-deterministic',
          messageData: {
            what: `Aspect '${idTrimmed}' declares 'references:' but reviewer.type is 'deterministic'.`,
            why: 'reference files are passed to the LLM reviewer in the prompt. Deterministic aspects run a local check.mjs and ignore them.',
            next: `remove 'references:' from .yggdrasil/aspects/${idTrimmed}/yg-aspect.yaml, or embed lookup tables in check.mjs directly, or change reviewer.type to 'llm'.`,
          },
        }],
      };
    }
    // An aggregating aspect has no LLM reviewer prompt, so references go nowhere.
    if (reviewer.type === 'aggregate') {
      return {
        ok: false,
        aspectId: idTrimmed,
        errors: [{
          code: 'aspect-references-on-aggregate',
          messageData: {
            what: `Aspect '${idTrimmed}' declares 'references:' but it is an aggregating aspect (no content.md, no check.mjs).`,
            why: 'reference files are passed to the LLM reviewer in the prompt. An aggregating aspect has no own reviewer — it only bundles implied aspects, so references would never be read.',
            next: `remove 'references:' from .yggdrasil/aspects/${idTrimmed}/yg-aspect.yaml, or add a content.md and move the references onto that LLM aspect.`,
          },
        }],
      };
    }
    references = [];
    const seenPaths = new Set<string>();
    for (let i = 0; i < raw.references.length; i++) {
      const entry = raw.references[i];
      let rawPath: string;
      let description: string | undefined;
      if (typeof entry === 'string') {
        rawPath = entry;
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.path !== 'string') {
          return {
            ok: false,
            aspectId: idTrimmed,
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
        rawPath = obj.path;
        if (obj.description !== undefined) {
          if (typeof obj.description !== 'string') {
            return {
              ok: false,
              aspectId: idTrimmed,
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
          aspectId: idTrimmed,
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
          aspectId: idTrimmed,
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
          aspectId: idTrimmed,
          errors: [{
            code: 'aspect-reference-escape',
            messageData: {
              what: `Aspect '${idTrimmed}' reference '${rawPath}' escapes the repository root.`,
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
          aspectId: idTrimmed,
          errors: [{
            code: 'aspect-reference-duplicate',
            messageData: {
              what: `Aspect '${idTrimmed}' lists '${normalized}' more than once under 'references:'.`,
              why: 'duplicate references inflate the prompt and indicate a copy-paste error.',
              next: `remove the duplicate entry from .yggdrasil/aspects/${idTrimmed}/yg-aspect.yaml.`,
            },
          }],
        };
      }
      seenPaths.add(normalized);
      references.push({ path: normalized, description });
    }
  }

  // scope: — optional review granularity block
  let scope: ScopeDef | undefined;
  if (raw.scope !== undefined) {
    const scopeResult = parseScope(raw.scope, idTrimmed, aspectYamlPath, reviewer.type);
    if (!scopeResult.ok) {
      return { ok: false, aspectId: idTrimmed, errors: scopeResult.errors };
    }
    scope = scopeResult.value;
  }

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
      artifacts,
      ...(references && { references }),
      ...(status !== undefined && { status }),
      ...(errs !== undefined && { errs }),
      ...(scope !== undefined && { scope }),
      ...(hasCompanionMjs && { hasCompanion: true }),
    },
  };
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
  | { ok: false; errors: Array<{ code: string; messageData: IssueMessage }> }
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
        code: 'aspect-reviewer-missing',
        messageData: {
          what: `aspect '${aspectId}' has no reviewer: block and no rule source to infer one from`,
          why: 'an aspect must ship content.md (llm), check.mjs (deterministic), or declare implies (aggregating bundle); otherwise it does nothing',
          next: 'add `reviewer:\\n  type: llm` with a content.md, add a check.mjs, or add `implies:` to make this an aggregating aspect',
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
          what: `aspect '${aspectId}' has reviewer: value that is not a YAML mapping`,
          why: 'reviewer: accepts an object with type: and optional tier:',
          next: 'replace with `reviewer:\\n  type: llm`',
        },
      }],
    };
  }

  // Step 2+3: collect independent errors on the mapping
  const errors: Array<{ code: string; messageData: IssueMessage }> = [];
  const obj = raw as Record<string, unknown>;

  // Step 2: structural — type missing or invalid
  let typeValid = false;
  if (!('type' in obj)) {
    errors.push({
      code: 'aspect-reviewer-type-missing',
      messageData: {
        what: `aspect '${aspectId}' has reviewer: mapping without type:`,
        why: 'type: distinguishes LLM and deterministic aspects',
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
  const allowedKeys = new Set(['type', 'tier']);
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

  const type = obj.type as 'llm' | 'deterministic';
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
    if (type === 'deterministic') {
      return {
        ok: false,
        errors: [{
          code: 'aspect-tier-on-deterministic',
          messageData: {
            what: `aspect '${aspectId}' has reviewer.type: deterministic together with reviewer.tier: '${obj.tier}'`,
            why: 'Deterministic aspects run locally without an LLM; tiers do not apply',
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
):
  | { ok: true; value: ScopeDef }
  | { ok: false; errors: Array<{ code: string; messageData: IssueMessage }> }
{
  // scope on aggregate is forbidden — checked before any structural parsing
  if (reviewerType === 'aggregate') {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-on-aggregate',
        messageData: {
          what: `Aspect '${aspectId}' declares 'scope:' but it is an aggregating aspect (no content.md, no check.mjs).`,
          why: 'Aggregating aspects have no own rule source and produce no own verdict — scope controls review granularity for a rule source, so it has no meaning here.',
          next: `Remove 'scope:' from .yggdrasil/aspects/${aspectId}/yg-aspect.yaml, or add content.md / check.mjs to make this a non-aggregating aspect.`,
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
          what: `yg-aspect.yaml at ${aspectYamlPath}: 'scope' must be a YAML mapping`,
          why: "scope controls review granularity — it must be an object with 'per:' and optional 'files:'",
          next: "use 'scope:\\n  per: node' or 'scope:\\n  per: file' (optionally add files: filter)",
        },
      }],
    };
  }

  const obj = rawScope as Record<string, unknown>;

  // Reject unknown keys (only 'per' and 'files' are allowed)
  const ALLOWED_SCOPE_KEYS = new Set(['per', 'files']);
  const unknownScopeKeys = Object.keys(obj).filter(k => !ALLOWED_SCOPE_KEYS.has(k));
  if (unknownScopeKeys.length > 0) {
    return {
      ok: false,
      errors: [{
        code: 'aspect-scope-invalid',
        messageData: {
          what: `yg-aspect.yaml at ${aspectYamlPath}: unknown key '${unknownScopeKeys[0]}' in scope`,
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
          what: `yg-aspect.yaml at ${aspectYamlPath}: 'scope' block is missing required 'per:' field`,
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
          what: `yg-aspect.yaml at ${aspectYamlPath}: invalid scope.per value '${String(obj.per)}'`,
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
      files = parseFileWhen(obj.files, `yg-aspect.yaml at ${aspectYamlPath}: scope.files`, 'scope.files');
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
              : `yg-aspect.yaml at ${aspectYamlPath}: scope.files predicate is invalid: ${message}`,
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

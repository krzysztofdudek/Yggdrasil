import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import type { CheckCode } from '../../model/issue-code.js';
import { firstPartyProvider, committedKeyEndpoint } from '../../utils/known-providers.js';
import { parse as parseYaml } from 'yaml';
import { isTrackedByGit, readHeadFile } from '../../utils/git.js';
import { issueMsg } from './shared.js';

/**
 * Reviewer credentials and where they are sent — warnings only.
 *
 * yg-config.yaml is committed and yg-secrets.yaml is not; the docs say a key
 * belongs in the second (or in the environment). Where a key actually sits,
 * and where it goes, is the repository owner's call: Yggdrasil never refuses a
 * configuration over it and never withholds a key. It says what it sees:
 *
 *   - config-committed-api-key (warning): a tier in yg-config.yaml carries
 *     `config.api_key`. The key works; the warning says who can read it.
 *   - secrets-file-tracked (warning): .yggdrasil/yg-secrets.yaml is tracked by
 *     git (force-added past its .gitignore entry). Its keys still work.
 *   - reviewer-endpoint-committed (warning): a tier sends the developer's key to
 *     an endpoint named in the committed file only — a first-party provider's
 *     endpoint that is not its own, or an openai-compatible server receiving a
 *     stored config.api_key (see committedKeyEndpoint). The key is sent; the
 *     warning makes the destination visible on every check. An endpoint set
 *     in yg-secrets.yaml is the developer's own choice and is not flagged.
 *     Whether a key happens to be set on this machine is not asked: the finding
 *     is about the committed file, so it reads the same everywhere.
 *
 * None of these messages ever repeats the key itself.
 */
export function checkReviewerCredentials(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: CheckCode, md: IssueMessage): void => {
    issues.push({ severity: 'warning', code, rule: code, ...issueMsg(md), messageData: md });
  };

  const keyTiers = graph.config.committedReviewer?.apiKeyTiers ?? [];
  // Whether the key is already in history decides what is true to say: a key
  // only typed into the working tree has leaked nowhere yet, and telling its
  // owner to revoke it teaches them to ignore the finding.
  const inHistory = keyTiers.length > 0 ? apiKeyTiersAtHead(graph) : new Set<string>();
  for (const tier of keyTiers) {
    push('config-committed-api-key', inHistory.has(tier)
      ? {
        what: `The committed .yggdrasil/yg-config.yaml sets reviewer.tiers.${tier}.config.api_key — a credential in a file every clone and every fork receives.`,
        why: 'yg-config.yaml is shared through version control; a key in it is readable by anyone with the repository and stays in its history after it is removed. The reviewer still uses it — this is a warning, not a refusal.',
        next: `If the repository is private and sharing the key is intended, nothing to do. Otherwise move api_key into the gitignored .yggdrasil/yg-secrets.yaml (or the provider's environment variable) and replace the key — it is already in this history.`,
      }
      : {
        what: `.yggdrasil/yg-config.yaml sets reviewer.tiers.${tier}.config.api_key in your working copy — not committed yet, but the file is shared, so the next commit would publish the key.`,
        why: 'yg-config.yaml is shared through version control; a key committed in it is readable by anyone with the repository and stays in its history after it is removed. The reviewer still uses it — this is a warning, not a refusal.',
        next: `If sharing the key with everyone who can read this repository is intended, commit it as it is. Otherwise move api_key into the gitignored .yggdrasil/yg-secrets.yaml (or the provider's environment variable) before you commit — it is not in this history yet.`,
      });
  }

  if (isTrackedByGit(path.dirname(graph.rootPath), path.relative(path.dirname(graph.rootPath), path.join(graph.rootPath, 'yg-secrets.yaml')))) {
    push('secrets-file-tracked', {
      what: '.yggdrasil/yg-secrets.yaml is tracked by git.',
      why: 'yg-secrets.yaml is meant as the local overlay that holds reviewer keys; tracked, it travels with every push and clone like the committed config does. Its keys still work — this is a warning, not a refusal.',
      next: 'If sharing it is intended, nothing to do. Otherwise run `git rm --cached .yggdrasil/yg-secrets.yaml` and commit, keep the file listed in .yggdrasil/.gitignore, and replace any key it held — it is already in this history.',
    });
  }

  for (const [tierName, tier] of Object.entries(graph.config.reviewer?.tiers ?? {})) {
    const endpoint = committedKeyEndpoint(tier);
    if (endpoint === undefined) continue;
    const firstParty = firstPartyProvider(tier.provider);
    if (firstParty === undefined) {
      push('reviewer-endpoint-committed', {
        what: `Tier '${tierName}' (${tier.provider}) sends the api_key it holds in yg-secrets.yaml to ${endpoint}, an endpoint named in the committed yg-config.yaml only.`,
        why: 'A committed endpoint is set by whoever last changed the shared file, while a key in yg-secrets.yaml belongs to whoever runs yg check --approve — often stored for another reviewer. The key is sent; this warning only shows where.',
        next: `If this endpoint is yours, name it for tier '${tierName}' in .yggdrasil/yg-secrets.yaml (reviewer.tiers.${tierName}.config.endpoint) and the warning goes away; otherwise remove the api_key there (OPENAI_COMPATIBLE_API_KEY is the variable meant for this server).`,
      });
      continue;
    }
    const plainHttp = /^http:\/\//i.test(endpoint);
    push('reviewer-endpoint-committed', {
      what: `Tier '${tierName}' (${tier.provider}) sends its API key and the reviewed source to ${endpoint}${plainHttp ? ', over plain http,' : ''} — an endpoint named in the committed yg-config.yaml only, not ${firstParty.endpoint}.`,
      why: `A committed endpoint is set by whoever last changed the shared file, while the key ($${firstParty.envVar}, or config.api_key) belongs to whoever runs yg check --approve${plainHttp ? ', and over http the key crosses the network unencrypted' : ''}. The key is sent; this warning only shows where.`,
      next: `If this endpoint is yours (a proxy or gateway you run), nothing to do — or name it for tier '${tierName}' in .yggdrasil/yg-secrets.yaml (reviewer.tiers.${tierName}.config.endpoint) and the warning goes away; otherwise remove config.endpoint from yg-config.yaml.`,
    });
  }
  return issues;
}

/**
 * The tiers whose `config.api_key` the last commit's yg-config.yaml already
 * holds. Empty when there is no commit, no repository, or the committed file
 * does not parse — then nothing is known to be in history.
 */
function apiKeyTiersAtHead(graph: Graph): Set<string> {
  const repoRoot = path.dirname(graph.rootPath);
  const text = readHeadFile(repoRoot, path.relative(repoRoot, path.join(graph.rootPath, 'yg-config.yaml')));
  if (text === null) return new Set();
  try {
    const tiers = (parseYaml(text) as { reviewer?: { tiers?: Record<string, { config?: { api_key?: unknown } } | null> } } | null)?.reviewer?.tiers;
    if (tiers === undefined || tiers === null || typeof tiers !== 'object') return new Set();
    return new Set(Object.entries(tiers).filter(([, t]) => {
      const key = t?.config?.api_key;
      return key !== undefined && key !== null && key !== '';
    }).map(([name]) => name));
  } catch {
    return new Set();
  }
}

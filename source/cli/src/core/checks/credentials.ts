import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { FIRST_PARTY_PROVIDERS } from '../../utils/known-providers.js';
import { isTrackedByGit } from '../../utils/git.js';
import { issueMsg } from './shared.js';

/**
 * Reviewer credentials and where they are sent.
 *
 * yg-config.yaml is committed and yg-secrets.yaml is not; the docs have always
 * said a key belongs only in the second (or in the environment). Nothing
 * enforced it, so a key committed by accident kept `yg check` — the
 * repository's own guardrail — green. Now:
 *
 *   - config-committed-api-key (error): a tier in the committed yg-config.yaml
 *     carries `config.api_key`.
 *   - secrets-file-tracked (error): .yggdrasil/yg-secrets.yaml is tracked by git
 *     (force-added past its .gitignore entry).
 *   - reviewer-endpoint-committed (warning): a first-party provider's tier would
 *     send the key from its environment variable to an endpoint the committed
 *     file names that is not the provider's own, or is plain http. Whoever can
 *     change the committed file can point that key — and the reviewed source —
 *     at any host; the warning makes the redirection visible on every check,
 *     before any run sends it. A local override in yg-secrets.yaml, or a key
 *     set in the overlay, is the developer's own choice and is not flagged.
 *     Whether the variable happens to be set on this machine is not asked: the
 *     finding is about the committed file, so it reads the same everywhere.
 *
 * Neither message ever repeats the key itself.
 */
export function checkReviewerCredentials(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (severity: 'error' | 'warning', code: string, md: IssueMessage): void => {
    issues.push({ severity, code, rule: code, ...issueMsg(md), messageData: md });
  };

  for (const tier of graph.config.committedReviewer?.apiKeyTiers ?? []) {
    push('error', 'config-committed-api-key', {
      what: `The committed .yggdrasil/yg-config.yaml sets reviewer.tiers.${tier}.config.api_key — a credential in a file every clone and every fork receives.`,
      why: 'yg-config.yaml is shared through version control; a key in it is readable by anyone with the repository and stays in its history after it is removed.',
      next: `Remove api_key from yg-config.yaml and put it in the gitignored .yggdrasil/yg-secrets.yaml (or the provider's environment variable), then revoke and replace the key — it has already been exposed to everyone who can read this history.`,
    });
  }

  if (isTrackedByGit(path.dirname(graph.rootPath), path.relative(path.dirname(graph.rootPath), path.join(graph.rootPath, 'yg-secrets.yaml')))) {
    push('error', 'secrets-file-tracked', {
      what: '.yggdrasil/yg-secrets.yaml is tracked by git.',
      why: 'yg-secrets.yaml is the local, never-committed overlay that holds reviewer keys; tracked, it travels with every push and clone like the committed config does.',
      next: 'Run `git rm --cached .yggdrasil/yg-secrets.yaml` and commit, keep the file listed in .yggdrasil/.gitignore, and replace any key it held — it has already been exposed to everyone who can read this history.',
    });
  }

  const committedEndpoints = graph.config.committedReviewer?.endpoints ?? {};
  for (const [tierName, tier] of Object.entries(graph.config.reviewer?.tiers ?? {})) {
    const firstParty = Object.hasOwn(FIRST_PARTY_PROVIDERS, tier.provider)
      ? FIRST_PARTY_PROVIDERS[tier.provider as keyof typeof FIRST_PARTY_PROVIDERS]
      : undefined;
    const committed = committedEndpoints[tierName];
    if (!firstParty || committed === undefined) continue;
    // Overridden locally (the effective endpoint is not the committed one), or a
    // key configured explicitly rather than taken from the environment: not the
    // committed file's doing.
    if (tier.endpoint?.trim() !== committed || tier.api_key) continue;
    const plainHttp = /^http:\/\//i.test(committed);
    const nonDefault = committed.replace(/\/+$/, '') !== firstParty.endpoint;
    if (!plainHttp && !nonDefault) continue;
    push('warning', 'reviewer-endpoint-committed', {
      what: `Tier '${tierName}' (${tier.provider}) would send $${firstParty.envVar} and the reviewed source to ${committed}, an endpoint named in the committed yg-config.yaml${plainHttp ? ' over plain http' : ''} — not ${firstParty.endpoint}.`,
      why: `A committed endpoint is set by whoever last changed the committed file, while the key comes from the environment of whoever runs yg check --approve; the two meet on that run${plainHttp ? ', and over http the key crosses the network unencrypted' : ''}.`,
      next: `If this endpoint is yours (a proxy or gateway you run), move config.endpoint into .yggdrasil/yg-secrets.yaml so it is a local choice; otherwise remove it from yg-config.yaml and unset ${firstParty.envVar} before running yg check --approve on this branch.`,
    });
  }
  return issues;
}

import type { IssueMessage } from '../model/validation.js';
import type { AspectStatus } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';

function posixPath(p: string): string {
  return toPosixPath(p);
}

export function aspectStatusInvalidMessage(params: {
  aspectId: string;
  value: string;
  aspectDir: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' declares status: '${params.value}' (not a valid value).`,
    why: 'Status must be one of: draft, advisory, enforced.',
    next: `Edit ${posixPath(params.aspectDir)}/yg-aspect.yaml and set status to one of the three valid values. See: yg knowledge read aspect-status.`,
  };
}

export function aspectReviewByMalformedMessage(params: {
  aspectId: string;
  value: string;
  aspectDir: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' declares review_by: '${params.value}' (not a valid calendar date).`,
    why: 'review_by must be a bare ISO calendar date in the form YYYY-MM-DD (e.g. 2027-01-15) — the day the rule is next due for review. A present-but-malformed date must be rejected, never silently ignored.',
    next: `Edit ${posixPath(params.aspectDir)}/yg-aspect.yaml and set review_by to a real YYYY-MM-DD date, or remove the field.`,
  };
}

export function impliesStatusInheritInvalidMessage(params: {
  implierId: string;
  impliedId: string;
  value: string;
  aspectDir: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.implierId}' implies aspect '${params.impliedId}' with status_inherit: '${params.value}' (not a valid value).`,
    why: 'status_inherit must be one of: strictest, own-default.',
    next: `Edit ${posixPath(params.aspectDir)}/yg-aspect.yaml. Use 'strictest' (default — implied aspect promotes to implier's status if higher) or 'own-default' (implied aspect keeps its own aspect-default).`,
  };
}

/**
 * Readable name of an attach site, from the machine origin token the status
 * resolver records (`own:`, `ancestor:`, `type:`, `ancestor-type:`, `flow:`,
 * `port:`). The downgrade message has to name the site that DECLARES the lower
 * status, so the person edits the file that actually says it.
 */
export function describeAttachSite(origin: string): string {
  const [kind, ...restParts] = origin.split(':');
  const rest = restParts.join(':');
  switch (kind) {
    case 'own': return `node '${posixPath(rest)}' (its own yg-node.yaml)`;
    case 'ancestor': return `ancestor node '${posixPath(rest)}'`;
    case 'type': return `node type '${rest}' in yg-architecture.yaml`;
    case 'ancestor-type': {
      const [type, at] = rest.split('@');
      return `node type '${type}' in yg-architecture.yaml (via ancestor '${posixPath(at ?? '')}')`;
    }
    case 'flow': return `flow '${posixPath(rest)}'`;
    case 'port': {
      const [port, target] = rest.split('@');
      return `port '${port}' on node '${posixPath(target ?? '')}'`;
    }
    default: return origin;
  }
}

/**
 * The downgrade finding reported ONCE per declaring site: the site that
 * declares the lower status, the status the rule already reaches the nodes
 * with and where that comes from, and which nodes it concerns — never one copy
 * per node, which blamed each node for a declaration made in one place (a type,
 * a flow, a port, an ancestor) and repeated one fault as many times as that
 * place reaches.
 */
export function aspectStatusDowngradeSiteMessage(params: {
  aspectId: string;
  declared: AspectStatus;
  anchor: AspectStatus;
  /** Origin token of the attach site that declares the lower status. */
  declaringOrigin: string;
  /** Origin tokens of the other explicit sites that declare the anchor status. */
  anchorOrigins: string[];
  aspectDefault: AspectStatus;
  aspectDeclaresStatus: boolean;
  /** Every node the declaration reaches with the downgrade. */
  nodePaths: string[];
}): IssueMessage {
  const site = describeAttachSite(params.declaringOrigin);
  const fromDefault = params.aspectDefault === params.anchor;
  const defaultLabel = params.aspectDeclaresStatus
    ? `the aspect default (status: ${params.aspectDefault} in the aspect's yg-aspect.yaml)`
    : `the aspect default (${params.aspectDefault}, because the aspect's yg-aspect.yaml sets no status:)`;
  const sources = [...(fromDefault ? [defaultLabel] : []), ...params.anchorOrigins.map(describeAttachSite)];
  const fixes = [
    ...(fromDefault ? [`set a lower status: in the aspect's yg-aspect.yaml`] : []),
    ...params.anchorOrigins.map((o) => `lower the status on ${describeAttachSite(o)}`),
  ];
  const nodes = params.nodePaths.map(posixPath);
  const reach = nodes.length === 1
    ? `node '${nodes[0]}'`
    : `the ${nodes.length} nodes it attaches to there (${nodes.slice(0, 3).join(', ')}${nodes.length > 3 ? ', …' : ''})`;
  return {
    what: `Aspect '${params.aspectId}': ${site} declares status '${params.declared}', but the aspect already reaches ${reach} as '${params.anchor}' from ${sources.join(' and ')}.`,
    why: 'An explicit attach-site status cannot relax (downgrade) what already cascades — that would silently weaken enforcement. An attach site can only raise the status above the aspect default and the other sites, never lower it.',
    next: `Remove the explicit status from ${site} (let the cascade win), or, to weaken the rule everywhere, ${fixes.join(' and ')}. See: yg knowledge read aspect-status.`,
  };
}

export function aspectStatusDowngradeMessage(params: {
  nodePath: string;
  aspectId: string;
  declared: AspectStatus;
  anchor: AspectStatus;
  /** Origin token of the attach site that declares the lower status. */
  declaringOrigin: string;
  /** Origin tokens of the other explicit sites that declare the anchor status. */
  anchorOrigins: string[];
  /** The aspect's own default status (`enforced` when `status:` is omitted). */
  aspectDefault: AspectStatus;
  /** Whether the aspect declares `status:` at all. */
  aspectDeclaresStatus: boolean;
}): IssueMessage {
  const site = describeAttachSite(params.declaringOrigin);
  const fromDefault = params.aspectDefault === params.anchor;
  const defaultLabel = params.aspectDeclaresStatus
    ? `the aspect default (status: ${params.aspectDefault} in the aspect's yg-aspect.yaml)`
    : `the aspect default (${params.aspectDefault}, because the aspect's yg-aspect.yaml sets no status:)`;
  const sources = [...(fromDefault ? [defaultLabel] : []), ...params.anchorOrigins.map(describeAttachSite)];
  const fixes = [
    ...(fromDefault ? [`set a lower status: in the aspect's yg-aspect.yaml`] : []),
    ...params.anchorOrigins.map((o) => `lower the status on ${describeAttachSite(o)}`),
  ];
  return {
    what: `Aspect '${params.aspectId}' on node '${posixPath(params.nodePath)}': ${site} declares status '${params.declared}', but the aspect already reaches this node as '${params.anchor}' from ${sources.join(' and ')}.`,
    why: 'An explicit attach-site status cannot relax (downgrade) what already cascades — that would silently weaken enforcement. An attach site can only raise the status above the aspect default and the other sites, never lower it.',
    next: `Remove the explicit status from ${site} (let the cascade win), or, to weaken the rule everywhere, ${fixes.join(' and ')}. See: yg knowledge read aspect-status.`,
  };
}

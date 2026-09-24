// CLI renderer: prints one finding of a check report.
import type { CheckIssue } from '../core/check.js';

export function renderFinding(issue: CheckIssue): string {
  const md = issue.messageData;
  return [
    `  ${issue.code}  ${issue.nodePath ?? ''}  ${md.what}`,
    `            ${md.why}`,
    `            Fix: ${md.next}`,
    '',
    `Next: ${md.next}`,
  ].join('\n');
}

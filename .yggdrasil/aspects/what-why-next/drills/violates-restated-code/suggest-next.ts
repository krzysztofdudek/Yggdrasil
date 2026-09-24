// CLI renderer: the one next step a finished check points at.
import type { CheckIssue } from '../core/check.js';
import { next } from './output.js';

export function nextStep(first: CheckIssue): string {
  // The step names the finding again instead of what to do about it.
  return next(`Fix ${first.code} in ${first.nodePath ?? '.yggdrasil'}`);
}

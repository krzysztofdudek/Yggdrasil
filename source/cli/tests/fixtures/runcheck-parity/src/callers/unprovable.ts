import { runCheck, type RunCheckOptions } from '../core/check.js';

/**
 * UNPROVABLE — the options argument is a variable, and a second call spreads a
 * base object into its literal. Neither can be read statically, so the rule
 * must stay silent: `errs: under` means it fires only on provable omissions.
 */
export function viaVariable(graph: string, files: string[], options: RunCheckOptions): string[] {
  return runCheck(graph, files, options);
}

export function viaSpread(graph: string, files: string[], base: RunCheckOptions): string[] {
  return runCheck(graph, files, { ...base, nowUtc: () => new Date() });
}

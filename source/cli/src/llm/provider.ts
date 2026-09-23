import type { LlmConfig } from '../model/graph.js';
import type { LlmProvider } from './types.js';
import { debugWrite } from '../utils/debug-log.js';

type ProviderFactory = (config: LlmConfig) => LlmProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function createLlmProvider(config: LlmConfig): LlmProvider {
  const factory = registry.get(config.provider);
  if (!factory) throw new Error(`Unknown reviewer provider: ${config.provider}`);
  return factory(config);
}

/**
 * The line every reviewer-failure report ends with: the provider's full output
 * (a CLI's whole stderr, an API's HTTP status line, a raw unparseable reply) is
 * written only to the debug log, and only when debug is switched on.
 */
export const REVIEWER_DEBUG_HINT =
  "For the provider's full output, set `debug: true` in .yggdrasil/yg-config.yaml and re-run; it is written to .yggdrasil/.debug.log.";

/** Outcome of asking a provider whether it can run, with the cause when it cannot. */
export type ProviderProbe = { available: true } | { available: false; reason: string };

/**
 * Ask the provider whether it can run and, when it cannot, why — in the
 * provider's own words (binary not found, no API key, server not answering)
 * rather than one sentence for every kind of provider. Never throws: a probe
 * that throws is reported as unavailable with the thrown message.
 */
export async function probeProvider(provider: LlmProvider, providerName: string): Promise<ProviderProbe> {
  try {
    if (await provider.isAvailable()) return { available: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugWrite(`[probeProvider] ${providerName} isAvailable threw: ${msg}`);
    return { available: false, reason: `the availability check for '${providerName}' failed: ${msg}` };
  }
  let reason: string | undefined;
  try {
    reason = await provider.unavailableReason?.();
  } catch (e) {
    debugWrite(`[probeProvider] ${providerName} unavailableReason threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { available: false, reason: reason || `the '${providerName}' reviewer reported itself unavailable` };
}

/**
 * Mask credentials in text a reviewer provider hands back — a CLI's stderr, an
 * error message — before it reaches a report line or the debug log. The patterns
 * cover the key shapes the supported providers issue (Anthropic `sk-ant-…`,
 * OpenAI `sk-…`/`sk-proj-…`, Google `AIza…`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/
 * `github_pat_…`), an `Authorization: Bearer …` value, and a `key=`/`token=`/
 * `api_key: …` assignment. A masked value keeps a four-character prefix so the
 * reader can still tell which kind of key was meant.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|AIza)[A-Za-z0-9_-]{8,}/g, (_m, prefix: string) => `${prefix}[REDACTED]`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]');
}

/**
 * The last `max` characters of a provider's output, whitespace collapsed onto one
 * line and credentials masked — short enough for a report reason, and the end is
 * where a CLI prints the error that stopped it. Empty input gives ''.
 */
export function redactedTail(text: string, max = 300): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `…${oneLine.slice(-max)}` : oneLine;
}

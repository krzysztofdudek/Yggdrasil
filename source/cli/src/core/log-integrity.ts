import { createHash } from 'node:crypto';
import { parseLog } from './parsing/log-parser.js';

export type IntegrityCheck =
  | { ok: true }
  | { ok: false; reason: 'boundary_missing' | 'prefix_modified' };

/**
 * Normalise a log's line endings (CRLF and lone CR become LF) before any
 * offset or hash is taken. The append-only baseline must describe the log's
 * text, not the checkout's line-ending style: a `git clone` with
 * `core.autocrlf=true` (the Git for Windows default) turns every LF into CRLF,
 * and a raw-byte hash would then report the untouched history as rewritten.
 * An LF log is returned unchanged, so every existing LF baseline still matches.
 */
export function normalizeLogLineEndings(content: string): string {
  return content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
}

const DATETIME_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}Z$/;

/**
 * Verify the stored baseline (datetime + prefix hash) against current content.
 *
 * Algorithm:
 * 1. Reject if storedDatetime is not strict ISO (defense in depth against tampered baselines).
 * 0. Normalise line endings (see normalizeLogLineEndings) — offsets and the
 *    hash are taken over the LF form, the same form the baseline was hashed in.
 * 2. Parse currentContent. Find the entry whose datetime matches storedDatetime.
 *    Missing → boundary_missing.
 * 3. Compute sha256 over bytes [0..entry.offsetEnd). Compare to storedPrefixHash.
 *    Mismatch → prefix_modified.
 * 4. Match → ok.
 */
export function validateAppendOnly(
  currentContent: string,
  storedDatetime: string,
  storedPrefixHash: string,
): IntegrityCheck {
  if (!DATETIME_STRICT.test(storedDatetime)) {
    return { ok: false, reason: 'boundary_missing' };
  }

  const normalized = normalizeLogLineEndings(currentContent);
  const entries = parseLog(normalized);
  const boundary = entries.find(
    (e) => e.datetime === storedDatetime && DATETIME_STRICT.test(e.datetime),
  );
  if (!boundary) return { ok: false, reason: 'boundary_missing' };

  const bytes = Buffer.from(normalized, 'utf-8');
  const prefix = bytes.subarray(0, boundary.offsetEnd);
  const computed = createHash('sha256').update(prefix).digest('hex');
  if (computed !== storedPrefixHash) return { ok: false, reason: 'prefix_modified' };

  return { ok: true };
}

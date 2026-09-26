export type FormatViolationReason =
  | 'invalid_start'
  | 'invalid_header'
  | 'invalid_datetime'
  | 'level2_header_in_body'
  | 'out_of_order'
  | 'duplicate_datetime'
  | 'unclosed_code_fence';

export interface FormatViolation {
  /** 1-based line number */
  line: number;
  reason: FormatViolationReason;
  detail: string;
}

/**
 * Whether a log.md still carries git conflict markers — the one reading every
 * caller shares: the check's `log-conflict`, the fill that refuses to run over
 * one, closure that refuses to record a baseline over one, and merge-resolve.
 *
 * Only the unambiguous open/close markers count (seven `<` or seven `>` at line
 * start). A bare `=======` line does NOT: log.md is markdown, where a run of `=`
 * at line start is a legitimate setext underline or horizontal rule, and a real
 * conflict always writes the open and close markers too.
 */
export function logHasConflictMarkers(content: string): boolean {
  return /^<{7}/m.test(content) || /^>{7}/m.test(content);
}

const HEADER_LINE = /^## \[([^\]]+)\]\s*$/;
const DATETIME_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}Z$/;
const FENCE_LINE = /^(`{3,})(.*)$/;

/**
 * Validate log.md format. CommonMark backtick-fence aware:
 * - Open fence: line matching ^`{3,}.*$
 * - Close fence: line matching ^`{N,}$ where N >= open length
 * - Tilde fences (~~~) and indented code blocks are NOT recognized.
 */
export function validateFormat(content: string): FormatViolation[] {
  const violations: FormatViolation[] = [];

  if (content === '') return violations;

  const lines = content.split('\n');

  if (!HEADER_LINE.test(lines[0])) {
    violations.push({
      line: 1,
      reason: 'invalid_start',
      detail: 'File must start with `## [<datetime>]` or be empty',
    });
  }

  let fenceOpen = false;
  let fenceOpenLen = 0;
  let fenceOpenLine = 0;
  let inEntryBody = false;
  let lastDatetime: string | null = null;
  const seenDatetimes = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const fenceMatch = FENCE_LINE.exec(line);

    if (fenceOpen) {
      if (fenceMatch && fenceMatch[2].trim() === '' && fenceMatch[1].length >= fenceOpenLen) {
        fenceOpen = false;
      }
      continue;
    } else {
      if (fenceMatch) {
        fenceOpen = true;
        fenceOpenLen = fenceMatch[1].length;
        fenceOpenLine = lineNo;
        continue;
      }
    }

    const headerMatch = HEADER_LINE.exec(line);
    if (headerMatch) {
      const datetimeRaw = headerMatch[1];
      if (!DATETIME_STRICT.test(datetimeRaw)) {
        const parsed = Date.parse(datetimeRaw);
        if (Number.isNaN(parsed)) {
          violations.push({
            line: lineNo,
            reason: 'invalid_header',
            detail: `Datetime '${datetimeRaw}' is not parseable`,
          });
        } else {
          violations.push({
            line: lineNo,
            reason: 'invalid_datetime',
            detail: `Datetime must be ISO 8601 UTC with milliseconds and Z suffix, got '${datetimeRaw}'`,
          });
        }
      } else {
        if (seenDatetimes.has(datetimeRaw)) {
          violations.push({
            line: lineNo,
            reason: 'duplicate_datetime',
            detail: `Datetime '${datetimeRaw}' also appears at line ${seenDatetimes.get(datetimeRaw)}`,
          });
        } else {
          seenDatetimes.set(datetimeRaw, lineNo);
        }
        if (lastDatetime !== null && datetimeRaw <= lastDatetime) {
          violations.push({
            line: lineNo,
            reason: 'out_of_order',
            detail: `Datetime '${datetimeRaw}' is not strictly greater than previous '${lastDatetime}'`,
          });
        }
        lastDatetime = datetimeRaw;
      }
      inEntryBody = true;
      continue;
    }

    if (inEntryBody && line.startsWith('## ')) {
      violations.push({
        line: lineNo,
        reason: 'level2_header_in_body',
        detail: `Level-2 header in body — use ### or higher, or wrap in code fence`,
      });
    }
  }

  if (fenceOpen) {
    violations.push({
      line: fenceOpenLine,
      reason: 'unclosed_code_fence',
      detail: 'Code fence opened but never closed before EOF',
    });
  }

  return violations;
}

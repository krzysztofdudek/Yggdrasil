// Parser adapter for a Thing file.
import { readTextFile } from '../io/graph-fs.js';
import { parse as parseYaml } from 'yaml';
import type { IssueMessage } from '../model/issue.js';

export interface Thing {
  name: string;
  tags: string[];
}

export interface ParseError {
  code: string;
  messageData: IssueMessage;
}

export type ParseResult =
  | { ok: true; value: Thing }
  | { ok: false; errors: ParseError[] };

export function parseThing(filePath: string): ParseResult {
  const raw = parseYaml(readTextFile(filePath)) as Record<string, unknown> | null;
  const errors: ParseError[] = [];

  if (typeof raw?.name !== 'string') {
    errors.push({
      code: 'thing-name-missing',
      messageData: {
        what: `${filePath}: 'name' must be a string`,
        why: 'A Thing without a name cannot be referenced by other graph elements.',
        next: `Set a string 'name:' field in ${filePath}.`,
      },
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const tags = Array.isArray(raw?.tags) ? (raw.tags as string[]) : [];
  return { ok: true, value: { name: raw!.name as string, tags } };
}

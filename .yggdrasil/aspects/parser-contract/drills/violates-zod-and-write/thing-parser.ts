// Parser adapter for a Thing file.
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export interface Thing {
  name: string;
}

const thingSchema = z.object({ name: z.string() });

export function parseThing(filePath: string): Thing {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const parsed = thingSchema.parse(raw);
  writeFileSync(`${filePath}.bak`, JSON.stringify(parsed));
  return parsed;
}

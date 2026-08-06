// Reads a project's optional presets directory; a fresh project may not have created it yet.
import { readdir } from 'node:fs/promises';

export async function readOptionalPresets(dir: string): Promise<string[]> {
  return await readdir(dir);
}

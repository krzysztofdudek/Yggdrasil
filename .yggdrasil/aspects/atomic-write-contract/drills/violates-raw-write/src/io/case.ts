import { writeFile } from 'node:fs/promises';

export async function save(p, data) {
  await writeFile(p, data);
}

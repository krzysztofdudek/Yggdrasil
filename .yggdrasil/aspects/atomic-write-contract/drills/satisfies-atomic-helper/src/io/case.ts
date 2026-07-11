import { atomicWriteFile } from '../atomic-write.js';

export async function save(p, data) {
  await atomicWriteFile(p, data);
}

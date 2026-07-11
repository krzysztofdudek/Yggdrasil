import { readFileOrDefault } from '../read-or-default.js';

export async function readOr(p, fallback) {
  return readFileOrDefault(p, fallback);
}

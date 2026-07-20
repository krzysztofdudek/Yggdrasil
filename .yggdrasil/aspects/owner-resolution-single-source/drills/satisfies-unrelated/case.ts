// An unrelated module with no mapping-path import at all. MUST pass.
import { toPosixPath } from '../utils/posix.js';

export function normalize(p) {
  return toPosixPath(p);
}

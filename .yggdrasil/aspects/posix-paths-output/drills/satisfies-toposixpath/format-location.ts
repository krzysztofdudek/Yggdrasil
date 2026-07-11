// Formats a node's on-disk location for display and storage.
import { toPosixPath } from '../utils/posix.js';

export function formatNodeLocation(dir: string, file: string): string {
  return toPosixPath(`${dir}/${file}/`);
}

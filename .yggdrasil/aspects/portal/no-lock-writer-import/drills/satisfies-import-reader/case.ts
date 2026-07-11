import { readLock } from '../lock-store.js';

export function load(root) {
  return readLock(root);
}

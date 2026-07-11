import { writeLock } from '../lock-store.js';

export function persist(lock) {
  writeLock(lock);
}

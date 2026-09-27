import { readLock, writeLockSync } from "../lock-store.js";

export function touch(root) {
  writeLockSync(root, readLock(root));
}

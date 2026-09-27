import * as store from "../lock-store.js";

export function saveTypes(root, types) {
  const persist = store.writeTypeLock;
  return persist(root, types);
}

// Never actually executed: the implies cycle stops resolution before any
// review runs, on every caller. This file exists only so cyclic-a is a real,
// loadable deterministic rule rather than a content-less stub.
export function check(_ctx) {
  return [];
}

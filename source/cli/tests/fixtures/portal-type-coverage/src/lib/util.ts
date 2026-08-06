// Matches the lib classifying type, which attaches no aspects at all — no
// node maps this file and no rule ever runs against it. Satisfies coverage
// through the type-level lattice alone, with zero enforcement: the state
// `yg check` names under "satisfy coverage with no enforcement".
export function helper(): string {
  return 'helper';
}

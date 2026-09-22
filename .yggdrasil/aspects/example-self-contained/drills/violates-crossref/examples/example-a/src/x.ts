// Drill case: a source file inside example-a reaches into a SIBLING example
// (example-b) via a relative import that resolves outside example-a's own
// directory. Expected verdict: refused (a cross-directory reference).
import { y } from '../../example-b/y';

export const value = y;

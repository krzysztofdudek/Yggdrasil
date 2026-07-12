// Drill case: a source file inside example-a references only its own directory
// via a relative import that resolves inside example-a. Expected verdict:
// satisfied (self-contained).
import { y } from './y';

export const value = y;

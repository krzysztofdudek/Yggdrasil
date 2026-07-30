// Shared path constants for the type-level-engine fixture's variants. Each
// variant is a small set of files a test copies OVER a mkdtemp copy of the
// base fixture (tests/fixtures/type-level-engine/) before loading it — never
// a standalone fixture project of its own. Exporting the paths from one place
// means a renamed or moved variant directory breaks compilation here rather
// than silently skipping whatever test consumed it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** An explicit mapping outranks a coverage exclusion (T6). */
export const FIXTURE_EXCLUDED_BUT_MAPPED = path.join(__dirname, 'excluded-but-mapped');

/** One refusing file must not suppress review of another (T6). */
export const FIXTURE_TWO_COVERED_FILES = path.join(__dirname, 'two-covered-files');

/** A file can be covered by its type with nothing applicable per-file (T8). */
export const FIXTURE_ZERO_ENFORCEMENT = path.join(__dirname, 'zero-enforcement');

/** A rule live only on files, with no component anywhere, is not dead law (T8). */
export const FIXTURE_TYPE_ONLY = path.join(__dirname, 'type-only');

/** Real check.mjs fixtures driving the deterministic runner's nodeless (component-free) unit directly. */
export const FIXTURE_NODELESS_RUNNER = path.join(__dirname, 'nodeless-runner');

/** A type-covered file's read allowance must resolve ownership with child-wins, the same as the live type gate. */
export const FIXTURE_REACH_PARITY = path.join(__dirname, 'reach-parity');

/** An LLM rule dropped as binary-subject must never be silently counted as enforced. */
export const FIXTURE_BINARY_SUBJECT = path.join(__dirname, 'binary-subject');

/** A type-covered file whose type's rules hit an implies cycle must be told the cycle, never "nothing applies". */
export const FIXTURE_CYCLIC_TYPE = path.join(__dirname, 'cyclic-type');

/**
 * One (rule, unit) pair the check expects a verdict for: the rule, its reviewer
 * kind, the unit (a node or one file), the owning node when there is one, the rule's
 * effective status there, and the files the verdict is about. Pure types, in the model
 * layer so modules that pair enumeration itself calls (the impact graph among them)
 * can name a pair without depending back on it; core/pairs.ts re-exports it.
 */
import type { AspectStatus } from './graph.js';
import type { UnitKey } from './lock.js';

export interface ExpectedPair {
  aspectId: string;
  kind: 'llm' | 'deterministic';
  unitKey: UnitKey;          // nodeUnit(nodePath) for per-node; fileUnit(path) per-file
  /**
   * The component that owns this unit. Absent when the file is enforced by its
   * architecture type and no component owns it — there is no owner to name, and
   * inventing one would put a component in front of a person that does not exist.
   */
  nodePath?: string;
  status: AspectStatus;      // effective status on the node (for rendering/severity)
  subjectFiles: string[];    // repo-relative POSIX, sorted
}

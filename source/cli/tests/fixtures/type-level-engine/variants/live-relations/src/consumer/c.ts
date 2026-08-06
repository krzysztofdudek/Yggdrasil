// Matched by 'consumer' (parents: [classifying-parent]). Overlays the base
// fixture's content-free c.ts with a REAL import of a leaf-typed file, so the
// relations: atoms this variant's aspects gate on are answered from a real,
// statically-resolved import edge rather than a hand-built TypedEdgeIndex.
import { a } from '../leaf/a.js';

export const c = a;

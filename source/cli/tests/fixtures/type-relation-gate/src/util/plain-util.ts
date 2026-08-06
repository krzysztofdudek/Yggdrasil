// Matches ONLY util, cleanly (no ambiguity). Imports the explicit node's file:
// util -> owner-type, VACUOUS allow (util has no relations table).
import { ownerThing } from '../owner/target.ts';
export const plainUtilThing = ownerThing;

// Matches ONLY svc. Three imports exercise three distinct rows:
//   -> target.ts:      svc -> owner-type, FORBIDDEN (owner-type not in calls: [util])
//   -> plain-util.ts:   svc -> util,       ALLOWED (explicit calls: [util] entry)
//   -> ambiguous.ts:    edge into an ambiguous file — NOT gated at all
import { ownerThing } from '../owner/target.ts';
import { plainUtilThing } from '../util/plain-util.ts';
import { ambiguousThing } from './ambiguous.ts';
export const handlerThing = [ownerThing, plainUtilThing, ambiguousThing];

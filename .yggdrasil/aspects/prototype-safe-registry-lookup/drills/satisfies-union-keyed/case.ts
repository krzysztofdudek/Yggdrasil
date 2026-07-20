// The registry's declared key type is a finite union, so the type system
// constrains the index to own keys — no inherited key can ever be reached. This
// is the dominant false-positive shape the check must NOT flag. Must pass.
type Reason = 'added' | 'removed' | 'changed';

const REASON_GLOSS: Record<Reason, string> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
};

export function gloss(reasons: Reason[]): string {
  return reasons.map((r) => REASON_GLOSS[r]).join(', ');
}

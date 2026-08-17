export function beforeRange(): number {
  return 0;
}

// yg-suppress-disable(no-todo) intentional legacy rounding, tracked in TICKET-402
// TODO: replace this rounding hack once TICKET-402 ships
const roundingHack = 1;
// yg-suppress-enable(no-todo)

export function range(): number {
  return roundingHack;
}

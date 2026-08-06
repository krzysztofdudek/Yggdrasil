// Matches the svc classifying type — no node maps this file, so it is
// satisfied by type-level coverage alone. It still carries a real,
// deterministic aspect (no-todo-comments) via its matched type's default
// aspect list, and the FIXME below trips it — a genuine refused verdict on a
// file the graph maps to no component.
export function handle(): string {
  // FIXME: replace with the real dispatch table
  return 'handled';
}

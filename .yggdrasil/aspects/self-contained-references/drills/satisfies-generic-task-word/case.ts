// Drill case: "task" used as an ordinary English word (a queued unit of
// work), not one of the vague planning-reference phrases this check
// targets. Expected verdict: satisfied.
export function scheduleTask(fn: () => void): void {
  // Runs the given task on the next tick of the event loop.
  queueMicrotask(fn);
}

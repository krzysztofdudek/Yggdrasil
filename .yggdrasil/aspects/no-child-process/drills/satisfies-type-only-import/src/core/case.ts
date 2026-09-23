import type { ChildProcess } from "node:child_process";

export function pidOf(child: ChildProcess): number | undefined {
  return child.pid;
}

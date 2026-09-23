import { execFileSync } from "node:child_process";

export function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
}

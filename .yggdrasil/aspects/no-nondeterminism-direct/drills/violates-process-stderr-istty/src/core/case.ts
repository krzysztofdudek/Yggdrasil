export function interactive(): boolean {
  return process.stderr.isTTY ?? false;
}

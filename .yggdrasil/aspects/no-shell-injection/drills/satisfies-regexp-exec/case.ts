const HEADER = /^## \[(.+)\]/;
export function parse(line: string): string | undefined {
  const m = HEADER.exec(line);
  return m ? m[1] : undefined;
}

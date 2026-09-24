let original: typeof process.stdout.write | null = null;

export function tee(copy: (text: string) => void): void {
  original = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk: string | Uint8Array): boolean {
    copy(String(chunk));
    return original!(chunk as string);
  } as typeof process.stdout.write;
}

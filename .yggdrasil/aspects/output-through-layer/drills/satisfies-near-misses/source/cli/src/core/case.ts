// Shapes that look like the forbidden ones and are not.
const quoted = (s: string): string => `'${s}'`;

export function lines(names: string[], owned: number, total: number, lang: string): string[] {
  return [
    // Code inside a substitution is not words: `.map((s) => …)`.
    `members: ${names.map((s) => quoted(s)).join(', ')}`,
    // `node-owned` is not the noun `nodes`.
    `${owned} node-owned of ${total}`,
    // A regular expression is not a string.
    String(/\w\(s\)/.test('x')),
    // A property named console is not the console.
    String({ console: 1 }.console),
    // Every file in one language, no count before the noun.
    `every ${lang} file`,
  ];
}

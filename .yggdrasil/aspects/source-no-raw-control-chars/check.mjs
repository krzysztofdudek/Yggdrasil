// source-no-raw-control-chars (enforced, errs: under)
//
// A raw control byte in the C0 range (0x00-0x1F) in a source file is invisible to
// typecheck, lint, and tests, and makes git treat the file as binary — so it
// never diffs and slips past review. This has recurred as a literal NUL (0x00)
// in a .ts / .mjs source file. This check refuses any file that contains such a
// byte, EXCEPT the three whitespace controls that legitimately occur in text:
// tab (0x09), line feed (0x0A), and carriage return (0x0D).
//
// STRING SCAN == RAW-BYTE SCAN (errs: under). The runner hands each file's
// decoded content as a JS string. Every C0 code point (0x00-0x1F) is a single
// UTF-8 byte whose value equals its code point, and a lone 0x00-0x1F byte is
// always valid single-byte UTF-8 that survives decoding intact. So scanning
// content.charCodeAt(i) over the range 0x00-0x1F is EXACTLY a raw-byte scan of
// that range: a hit is a provable raw control byte, never a false positive. No
// legitimate source text carries a raw NUL/control byte (the compliant form is
// the escape `\0` / `\x00`, ordinary ASCII), so this fires only on the defect.
//
// Reports the FIRST offending byte per file (a NUL-corrupted file is typically
// binary garbage throughout; one anchored report is enough — a re-run catches any
// residue once the file is repaired). The reported offset is the true UTF-8 byte
// offset, so it matches what a byte-level tool (git, hexdump) would show.

const ALLOWED = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR — legitimate in text

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    const content = file.content;
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code > 0x1f || ALLOWED.has(code)) continue;

      const hex = code.toString(16).padStart(2, '0');
      const byteOffset = Buffer.byteLength(content.slice(0, i), 'utf8');
      let line = 1;
      for (let j = 0; j < i; j++) {
        if (content.charCodeAt(j) === 0x0a) line++;
      }

      violations.push({
        file: file.path,
        line,
        column: 0,
        message:
          `Source file contains a raw control byte (0x${hex}) at byte offset ${byteOffset}.\n` +
          `A raw control byte (e.g. a literal NUL) is invisible to typecheck/lint/tests and ` +
          `makes git treat the file as binary, so it never diffs and slips past review.\n` +
          `Replace the raw byte with its escape (e.g. \\0 or \\x00 in a string literal), or remove it.`,
      });
      break; // one violation per file — anchored at the first offending byte
    }
  }

  return violations;
}

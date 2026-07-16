// docs-internal-links (deterministic, errs: under)
//
// Flags an internal markdown link on a documentation page whose target does not
// resolve to an existing documentation page. The check runs over the WHOLE doc
// set at once (ctx.files == every mapped doc page), so the set of pages that
// exist is exactly the set it can see — which is why ALL documentation must live
// in a SINGLE node for this rule to be complete (a split would let a link to a
// page in a sibling node read as broken). See the aspect description.
//
// ZERO FALSE POSITIVES BY DESIGN (errs: under). It fires ONLY on an internal
// link whose resolved target is provably absent from the known page set, and it
// SKIPS — never guesses — every construct it cannot resolve with certainty:
//   - external / protocol links (http:, https:, mailto:, tel:, //host)
//   - any target that carries a non-.md file extension (images, .html, .gif,
//     .svg, … live in docs/public/ — an EXTENSION-based skip, not a fixed list)
//   - same-page anchors (#section) and query-only targets
//   - image links (![alt](src)) and reference-style links [t][ref]
//   - escaped brackets, unbalanced-paren captures, and anything inside a fenced
//     code block, an indented code block, or an inline code span (documented
//     link EXAMPLES must never be resolved)
//
// It is a CONTENT check: markdown has no tree-sitter grammar, so it reads
// file.content and never touches file.ast. It uses ONLY ctx.files (no graph /
// node / fs / parseYaml), so it is self-contained. NOTE: code EXAMPLES in the
// docs must use fenced blocks (``` or ~~~) or inline code spans — a link example
// left as raw prose would be treated as a live link.

/** Longest common directory prefix (POSIX, segment-wise) of a set of file paths. */
function commonDir(paths) {
  if (paths.length === 0) return '';
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  let prefix = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    const segs = dirs[i];
    let k = 0;
    while (k < prefix.length && k < segs.length && prefix[k] === segs[k]) k++;
    prefix = prefix.slice(0, k);
    if (prefix.length === 0) break;
  }
  return prefix.join('/');
}

/** Resolve `spec` (may contain ./ and ../) against directory `fromDir`, POSIX. */
function resolveRelative(fromDir, spec) {
  const out = [];
  for (const part of `${fromDir}/${spec}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

/**
 * Blank out fenced code blocks, indented code blocks, and inline code spans so
 * link-shaped text inside them is never treated as a live link. Line count is
 * preserved so reported line numbers stay accurate.
 *
 * Fences: a real fence line is indented < 4 spaces and starts with >=3 backticks
 * or tildes; it closes only on a same-character run of >= the opening length (an
 * inner fence of the other character, or a shorter run, does NOT close it, and a
 * >=4-indent ``` is code content, not a fence). An unclosed fence runs to EOF —
 * failing toward skipping, never toward a false positive.
 *
 * Indented code blocks (CommonMark): a >=4-space / tab-indented non-blank line
 * that FOLLOWS a blank line begins a code block that continues over indented and
 * blank lines until a non-indented non-blank line. (This can skip a link inside a
 * deeply-indented list item — an acceptable under-approximation for errs: under.)
 */
function stripCode(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let fence = null;      // { ch, len } of the marker that opened the current fenced block
  let inIndent = false;  // inside an indented code block
  let prevBlank = true;  // start-of-doc counts as a blank boundary
  for (const line of lines) {
    const blank = line.trim() === '';
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len) fence = null;
      // A fence is a block boundary: treat the post-fence state as a blank
      // boundary so a following indented line reads as an indented code block.
      out.push(''); prevBlank = true; continue;
    }
    if (fm) { fence = { ch: fm[1][0], len: fm[1].length }; out.push(''); prevBlank = true; continue; }

    const indented = /^(\t| {4,})/.test(line);
    if (inIndent) {
      if (blank) { out.push(''); prevBlank = true; continue; }
      if (indented) { out.push(''); prevBlank = false; continue; }
      inIndent = false; // a non-indented non-blank line ends the block
    }
    if (!blank && indented && prevBlank) { inIndent = true; out.push(''); prevBlank = false; continue; }

    out.push(blank ? '' : line.replace(/`+[^`]*`+/g, '')); // inline code spans (any backtick run length)
    prevBlank = blank;
  }
  return out.join('\n');
}

/** Doc-root-relative clean-URL key for a repo-relative doc path. */
function keyFor(relPath) {
  return '/' + relPath.replace(/\.md$/i, '');
}

/** Number of backslashes immediately before position `i` in `s` (for escape parity). */
function backslashRun(s, i) {
  let n = 0, j = i - 1;
  while (j >= 0 && s[j] === '\\') { n++; j--; }
  return n;
}

export function check(ctx) {
  const violations = [];
  const mdFiles = ctx.files.filter((f) => /\.md$/i.test(f.path) && typeof f.content === 'string');
  if (mdFiles.length === 0) return violations;

  const root = commonDir(mdFiles.map((f) => f.path));
  const rootPrefix = root ? root + '/' : '';
  const relOf = (p) => (p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p);

  // Known clean-URL keys — every page, plus the directory alias for an index page.
  const known = new Set(['/']);
  for (const f of mdFiles) {
    const key = keyFor(relOf(f.path));
    known.add(key);
    if (/(^|\/)index$/i.test(key)) known.add(key.replace(/\/index$/i, '') || '/');
  }
  const isKnown = (k) => known.has(k) || known.has(k.replace(/\/+$/, '')) || known.has(k + '/');

  const LINK = /\]\(([^)\n]*)\)/g;
  for (const f of mdFiles) {
    const rel = relOf(f.path);
    const fileDir = ('/' + rel.replace(/\.md$/i, '')).replace(/\/[^/]*$/, '') || '/';
    const lines = stripCode(f.content).split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++) {
      const text = lines[ln];
      LINK.lastIndex = 0;
      let m;
      while ((m = LINK.exec(text))) {
        // Skip an escaped bracket (\]) — CommonMark renders it as literal text.
        if (backslashRun(text, m.index) % 2 === 1) continue;
        // Skip image links: `![alt](src)` is never a doc-page link.
        if (/!\[[^\]]*$/.test(text.slice(0, m.index))) continue;

        // Parse the destination out of the raw capture (destination is either a
        // <bracketed> URL or runs to the first whitespace; an optional title
        // follows the whitespace and is discarded).
        const raw = m[1].trim();
        if (raw === '') continue;
        let t;
        if (raw.startsWith('<')) {
          const close = raw.indexOf('>');
          t = close >= 0 ? raw.slice(1, close) : raw.slice(1);
        } else {
          t = raw.split(/\s/)[0];
        }
        t = t.trim();
        if (t === '') continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) continue; // scheme / //host
        if (t.includes('(') || t.includes(')')) continue;                    // unbalanced-paren capture — cannot resolve safely
        t = t.replace(/[?#].*$/s, '');                                        // strip ?query and #anchor
        if (t === '') continue;                                              // same-page anchor
        try { t = decodeURIComponent(t); } catch { /* keep raw on malformed % */ }

        // Extension-based skip: only extensionless (clean URL) and .md targets are
        // documentation pages. Anything else (image, .html, .gif, .svg, .yaml, …)
        // is a public asset or non-doc resource — skip it.
        const seg = t.split('/').pop() || '';
        const dot = seg.lastIndexOf('.');
        if (dot > 0 && seg.slice(dot).toLowerCase() !== '.md') continue;

        const key = t.startsWith('/')
          ? (t.replace(/\.md$/i, '').replace(/\/+$/, '') || '/')
          : (resolveRelative(fileDir, t).replace(/\.md$/i, '').replace(/(.)\/+$/, '$1') || '/');

        if (!isKnown(key)) {
          violations.push({
            file: f.path,
            line: ln + 1,
            column: m.index,
            message:
              `Internal documentation link '${raw}' in ${rel} does not resolve to an ` +
              `existing documentation page (resolved to '${key}'). Fix the link target, or ` +
              `the linked page's path if it moved.`,
          });
        }
      }
    }
  }
  return violations;
}

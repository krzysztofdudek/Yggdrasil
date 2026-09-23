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
//   - query-only targets
//   - image links (![alt](src)) and reference-style links [t][ref]
//   - escaped brackets, unbalanced-paren captures, and anything inside a fenced
//     code block, an indented code block, or an inline code span (documented
//     link EXAMPLES must never be resolved)
//
// A #fragment is checked too, against the anchors the target page (or, for a
// bare #fragment, the page itself) actually has: every heading's id as VitePress
// renders it (its own slugify, `{#custom-id}` overrides, and the -1/-2 suffixes
// for repeated headings), plus any literal id= / name= attribute in the page. A
// GitHub-style slug that VitePress does not produce (`yg-aspects---json` for the
// heading `yg aspects --json`) is a dead anchor on the published site. To stay
// errs: under, a fragment is reported only when it matches neither the exact
// heading text nor a looser reading of it with emphasis markers removed.
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

// VitePress's own slugify (from @mdit-vue/shared), copied verbatim so the anchor
// set this check builds is the one the published site renders.
const rControl = /[\u0000-\u001f]/g;
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g;
const rCombining = /[\u0300-\u036F]/g;
function slugify(str) {
  return str.normalize('NFKD').replace(rCombining, '').replace(rControl, '').replace(rSpecial, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1').toLowerCase();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Markdown-level rewrites of one non-code stretch of a heading. */
function inlineText(t, loose) {
  const escaped = [];
  t = t.replace(/\\([!-/:-@[-`{-~])/g, (_, c) => `${escaped.push(c) - 1}`); // hold backslash escapes aside
  t = t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images contribute no text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links contribute their text
    .replace(/<[^>]+>/g, '')                        // inline HTML is not text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
  if (loose) t = t.replace(/(\*\*|__|\*|_)/g, '');
  return t.replace(/(\d+)/g, (_, i) => escaped[Number(i)]);
}

/** The text VitePress reads off a heading (text and inline-code content only). */
function headingText(raw, loose) {
  let out = '';
  let last = 0;
  // Inline code spans are taken verbatim; everything around them is markdown.
  for (const m of raw.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
    out += inlineText(raw.slice(last, m.index), loose) + m[2];
    last = m.index + m[0].length;
  }
  return out + inlineText(raw.slice(last), loose);
}

/**
 * Every anchor a page renders: heading ids (with VitePress's slugify, custom
 * `{#id}` overrides, and -N suffixes for repeats) and literal id=/name= values.
 * `loose` is the errs: under safety net — a second reading of each heading with
 * emphasis markers removed, so an unusual heading never produces a false alarm.
 */
function anchorsOf(content, loose) {
  const anchors = new Set();
  const seen = Object.create(null);
  const add = (slug) => {
    let s = slug, i = 1;
    while (seen[s]) s = `${slug}-${i++}`;
    seen[s] = true;
    anchors.add(s);
  };
  const lines = content.split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len) fence = null; continue; }
    if (fm) { fence = { ch: fm[1][0], len: fm[1].length }; continue; }
    let text = null;
    const atx = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/);
    if (atx) text = (atx[1] ?? '').replace(/[ \t]+#+$/, '');
    else if (i + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1]) && line.trim() !== '' && !/^ {0,3}([-*+]|\d+[.)]|>|\|)/.test(line)) text = line.trim();
    if (text === null) continue;
    const custom = text.match(/\s*\{#([^}\s]+)\}\s*$/);
    if (custom) { add(custom[1]); continue; }
    add(slugify(headingText(text, loose)));
  }
  for (const m of content.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) anchors.add(m[1]);
  return anchors;
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

  // Page key → its content, for resolving #fragments against the target page.
  const pageByKey = new Map();
  for (const f of mdFiles) {
    const key = keyFor(relOf(f.path));
    pageByKey.set(key, f);
    if (/(^|\/)index$/i.test(key)) pageByKey.set(key.replace(/\/index$/i, '') || '/', f);
  }
  const pageFor = (k) => pageByKey.get(k) ?? pageByKey.get(k.replace(/\/+$/, '')) ?? pageByKey.get(k + '/');
  const anchorCache = new Map();
  const hasAnchor = (page, frag) => {
    if (!anchorCache.has(page.path)) anchorCache.set(page.path, [anchorsOf(page.content, false), anchorsOf(page.content, true)]);
    const [exact, loose] = anchorCache.get(page.path);
    return exact.has(frag) || loose.has(frag);
  };
  const fragmentViolation = (f, ln, column, raw, rel, page, frag) => ({
    file: f.path,
    line: ln + 1,
    column,
    message:
      `Internal documentation link '${raw}' in ${rel} points at '#${frag}', which is not an anchor ` +
      `on ${page === f ? 'this page' : `'${relOf(page.path)}'`}. The published site derives heading anchors ` +
      `with VitePress's slugify (not GitHub's): fix the fragment to the heading's real id, or give the ` +
      `heading an explicit {#id}.`,
  });

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
        const hashAt = t.indexOf('#');
        let frag = hashAt >= 0 ? t.slice(hashAt + 1) : '';
        try { frag = decodeURIComponent(frag); } catch { /* keep raw on malformed % */ }
        t = t.replace(/[?#].*$/s, '');                                        // strip ?query and #anchor
        if (t === '') {                                                      // same-page anchor
          if (frag !== '' && !raw.includes('?') && !hasAnchor(f, frag)) violations.push(fragmentViolation(f, ln, m.index, raw, rel, f, frag));
          continue;
        }
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

        if (isKnown(key)) {
          const page = pageFor(key);
          if (frag !== '' && !raw.includes('?') && page !== undefined && !hasAnchor(page, frag)) {
            violations.push(fragmentViolation(f, ln, m.index, raw, rel, page, frag));
          }
        } else {
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

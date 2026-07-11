#!/usr/bin/env node
// escape-scan — DOGFOOD reality-oracle seed. Read-only over git history. Makes ZERO
// LLM calls, writes NOTHING (never the lock, events, or drill-results), and is NOT
// wired into `yg` — it is a standalone `node scripts/escape-scan.mjs`, with no effect
// on any exit code, verdict, issue, or suggestedNext. No deps.
//
// WHAT: walks the mainline git history for FIX-flavored commits that touched a graph
// node's mapped source files, and — for each — reads the PARENT commit's COMMITTED
// non-deterministic lock (.yggdrasil/yg-lock.nondeterministic.json) to ask: was that
// node GREEN at the time (it had at least one committed verdict and NONE of them was
// a refusal), and was the parent on the mainline first-parent chain (the CI-green
// approximation)? When all three hold, the fix repaired code the reviewer had already
// approved — an ESCAPE CANDIDATE: a defect that slipped past a green verdict and was
// only caught later by a human. Each hit is surfaced for human triage.
//
// WHY: this is the first seed of the "reality oracle" — the outside-the-loop check on
// whether green verdicts actually mean defect-free. A reviewer that approves code which
// later needs a fix has let something through; collecting those fix-on-green commits
// gives a human a triage stream to inspect the misses and, over time, sharpen the rules
// that missed them. It is deliberately a STREAM for a person to read, not a score.
//
// HONESTY (mandatory, printed in the footer): this scan is a PROXY and is wrong in both
// directions. It UNDERCOUNTS — the deterministic verdict lock is local + gitignored,
// hence retroactively INVISIBLE in history, so this scan sees ONLY LLM refusals; and the
// live relation-conformance check leaves no lock trace at all. It OVERCOUNTS — not every
// fix-commit fixes a defect (docs, tests, refactors, and typo fixes all match the fix
// vocabulary). It is a triage STREAM, NEVER a gate, NEVER a metric.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const LOCK_PATH = '.yggdrasil/yg-lock.nondeterministic.json';
const MODEL_DIR = '.yggdrasil/model';
const out = (m = '') => process.stdout.write(m + '\n');

// Resolve the repo root so the scan is correct regardless of the cwd it is invoked
// from. All git commands then run with cwd = root and pathspecs relative to it.
function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
// git that is allowed to fail (missing rev/path) — returns null instead of throwing.
// stderr is ignored: a missing lock at a past commit ("fatal: path ... does not exist")
// is an EXPECTED, handled outcome here, not an error to surface.
const gitTry = (args) => {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

// ---- fix vocabulary --------------------------------------------------------------
// Conservative and documented: a commit is "fix-flavored" when its SUBJECT contains one
// of these words as a whole word (case-insensitive), which also covers the conventional
// `fix(scope):` / `fix!:` form (the `(` or `!` after `fix` is a non-word boundary). It
// deliberately does NOT match `prefix`, `suffix`, `affix`, `fixture`, or `debug`.
const FIX_WORDS = [
  'fix',
  'fixes',
  'fixed',
  'fixup',
  'bug',
  'bugs',
  'bugfix',
  'hotfix',
  'regression',
  'regressions',
];
const FIX_RE = new RegExp('(?:^|[^a-z0-9])(?:' + FIX_WORDS.join('|') + ')(?:[^a-z0-9]|$)', 'i');
const isFixFlavored = (subject) => FIX_RE.test(subject);

// ---- current-graph mapping (node ownership) -------------------------------------
// Node ownership is resolved against the CURRENT (HEAD working-tree) graph mappings.
// This is a documented approximation: historical mapping drift is possible, but the
// current graph is the reference model and reading every node's mapping at every parent
// commit would be far heavier. A minimal mapping read (below) avoids importing the built
// dist graph loader.
//
// Minimatch-style glob → RegExp. `*` matches within one path segment, `**` matches
// across segments; a trailing `/` on a mapping means "everything under this directory".
function globToRegExp(glob) {
  let g = glob.endsWith('/') ? glob + '**' : glob;
  // Escape regex specials, preserving the glob metacharacters * ? / for the next stage.
  g = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Placeholders (no regex specials, cannot occur in a path) protect the globstar forms
  // from the single-`*` replacement that follows.
  g = g
    .replace(/\/\*\*\//g, '<<GSS>>') // /**/  — zero or more full segments, keeping one slash
    .replace(/^\*\*\//g, '<<GSHEAD>>') // leading **/
    .replace(/\/\*\*$/g, '<<GSTAIL>>') // trailing /**
    .replace(/\*\*/g, '<<GS>>') // bare **
    .replace(/\*/g, '[^/]*') // single * — within a segment
    .replace(/\?/g, '[^/]'); // ? — one char within a segment
  g = g
    .replace(/<<GSS>>/g, '/(?:[^/]+/)*')
    .replace(/<<GSHEAD>>/g, '(?:[^/]+/)*')
    .replace(/<<GSTAIL>>/g, '(?:/.*)?')
    .replace(/<<GS>>/g, '.*');
  return new RegExp('^' + g + '$');
}

// Recursively collect every yg-node.yaml under .yggdrasil/model.
function findNodeYamls(absDir, acc) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) findNodeYamls(p, acc);
    else if (e.isFile() && e.name === 'yg-node.yaml') acc.push(p);
  }
  return acc;
}

// Minimal mapping read: extract the `mapping:` block-list globs from a yg-node.yaml
// without a YAML dependency (all node files use the block-list form; inline arrays are
// not used in this graph). Inline `# comments` and quotes are stripped.
function readMapping(absYaml) {
  const text = readFileSync(absYaml, 'utf-8');
  const lines = text.split('\n');
  const globs = [];
  let inBlock = false;
  for (const raw of lines) {
    if (/^mapping:\s*(\[\s*\])?\s*(#.*)?$/.test(raw)) {
      inBlock = /\[\s*\]/.test(raw) ? false : true; // `mapping: []` → empty, no block
      continue;
    }
    if (!inBlock) continue;
    const item = raw.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      let v = item[1].replace(/\s+#.*$/, '').trim(); // strip trailing inline comment
      v = v.replace(/^['"]|['"]$/g, ''); // strip surrounding quotes
      if (v) globs.push(v);
      continue;
    }
    if (/^\S/.test(raw)) inBlock = false; // a new top-level key ends the block
  }
  return globs;
}

// Build the node table once from the current graph.
function loadNodes() {
  const yamls = findNodeYamls(path.join(ROOT, MODEL_DIR), []);
  const modelAbs = path.join(ROOT, MODEL_DIR);
  const nodes = [];
  for (const abs of yamls) {
    const rel = path.relative(modelAbs, path.dirname(abs)).split(path.sep).join('/');
    const node = rel === '' ? '.' : rel;
    const patterns = readMapping(abs).map((g) => ({ src: g, re: globToRegExp(g) }));
    if (patterns.length) nodes.push({ node, patterns });
  }
  return nodes;
}
const NODES = loadNodes();

// ownerOf(path) → the most-specific node whose mapping matches, or null. Memoized:
// mapping is static across the scan, so each path is resolved once.
const ownerCache = new Map();
function ownerOf(filePath) {
  if (ownerCache.has(filePath)) return ownerCache.get(filePath);
  let best = null;
  let bestScore = [-1, -1];
  for (const n of NODES) {
    let matchedLen = -1;
    for (const p of n.patterns) if (p.re.test(filePath) && p.src.length > matchedLen) matchedLen = p.src.length;
    if (matchedLen < 0) continue;
    // Specificity: deeper node path wins; tie-break on the longer (more literal) glob.
    const score = [n.node.split('/').length, matchedLen];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = n.node;
      bestScore = score;
    }
  }
  ownerCache.set(filePath, best);
  return best;
}

// ---- lock reading ---------------------------------------------------------------
// Parse a parent commit's committed lock into a per-node tally: how many committed
// verdicts are ATTRIBUTABLE to each node, and how many of those are refusals. A verdict
// keyed `node:<path>` is attributed to that exact node; a verdict keyed `file:<path>` is
// attributed to the current owner of that file. Returns null when the lock is absent or
// unparseable at that commit (honest-empty — never crash).
const lockTallyCache = new Map(); // parentSha -> Map(node -> {total, refused}) | null
function nodeTallyAtParent(parentSha) {
  if (lockTallyCache.has(parentSha)) return lockTallyCache.get(parentSha);
  const raw = gitTry(['show', `${parentSha}:${LOCK_PATH}`]);
  if (raw == null) {
    lockTallyCache.set(parentSha, null);
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    lockTallyCache.set(parentSha, null);
    return null;
  }
  const tally = new Map();
  const bump = (node, refused) => {
    if (!node) return;
    const t = tally.get(node) || { total: 0, refused: 0 };
    t.total++;
    if (refused) t.refused++;
    tally.set(node, t);
  };
  const verdicts = data && typeof data === 'object' ? data.verdicts : undefined;
  if (verdicts && typeof verdicts === 'object') {
    for (const units of Object.values(verdicts)) {
      if (!units || typeof units !== 'object') continue;
      for (const [unitKey, entry] of Object.entries(units)) {
        if (!entry || typeof entry !== 'object') continue;
        const refused = entry.verdict === 'refused';
        if (unitKey.startsWith('node:')) bump(unitKey.slice(5), refused);
        else if (unitKey.startsWith('file:')) bump(ownerOf(unitKey.slice(5)), refused);
      }
    }
  }
  lockTallyCache.set(parentSha, tally);
  return tally;
}

// ---- mainline + CI-green approximation ------------------------------------------
// The scan walks the MAINLINE history (the shipped product). CI-green is APPROXIMATED
// by "the parent commit is on the mainline FIRST-PARENT chain" — i.e. the buggy code
// was merged to the mainline and (approximately) passed CI. A full CI-status join needs
// the GitHub Actions API and is out of scope for an offline script.
function resolveMainline() {
  const candidates = [process.env.YG_ESCAPE_MAINLINE, 'main', 'origin/main', 'HEAD'].filter(Boolean);
  for (const ref of candidates) {
    if (gitTry(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}
// The body runs inside main() and the process exits NATURALLY (no process.exit). When
// stdout is a pipe, `process.stdout.write` is asynchronous and a large report is buffered;
// calling process.exit() would terminate before that buffer flushed and TRUNCATE the tail
// (footer + honesty labels). Letting main() return lets the event loop drain stdout first.
function main() {
  const MAINLINE_REF = resolveMainline();

  out('escape-scan — fix-on-green escape candidates for human triage (reality-oracle seed)');
  out('Read-only over git history. Makes ZERO LLM calls, writes NOTHING. Not wired into `yg`.');

  if (!MAINLINE_REF) {
    out('');
    out('No mainline ref resolved (no main / origin/main / HEAD). Nothing to scan.');
    out('');
    emitFooter();
    return;
  }

  const firstParentMain = new Set(
    git(['rev-list', '--first-parent', MAINLINE_REF]).split('\n').map((s) => s.trim()).filter(Boolean),
  );

  out(`Mainline: ${MAINLINE_REF} — first-parent chain is the CI-green approximation.`);
  out(`Fix vocabulary (whole-word, case-insensitive): ${FIX_WORDS.join(', ')} (+ conventional fix(scope):).`);
  out('');

  // ---- walk ---------------------------------------------------------------------
  const commitLines = git(['log', '--format=%H %s', MAINLINE_REF])
    .split('\n')
    .filter((l) => l.length > 41);

  let totalCommits = 0;
  let fixCommits = 0;
  let fixTouchingCoveredNode = 0;
  const candidates = []; // {sha, node, parentSha, subject}
  let exclNotFirstParent = 0;
  let exclNoParentLock = 0;
  let exclUncoveredAtParent = 0;
  let exclRefusedAtParent = 0; // healthy: the reviewer already caught it

  for (const line of commitLines) {
    totalCommits++;
    const sha = line.slice(0, 40);
    const subject = line.slice(41);
    if (!isFixFlavored(subject)) continue;
    fixCommits++;

    // Files this fix touched, diffed against its FIRST parent (so a merge is compared to
    // the mainline side). Resolve each to its owning node.
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--first-parent', sha])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const touchedNodes = new Set();
    for (const f of files) {
      const owner = ownerOf(f);
      if (owner) touchedNodes.add(owner);
    }
    if (touchedNodes.size === 0) continue;
    fixTouchingCoveredNode++;

    const parentSha = (gitTry(['rev-parse', `${sha}^1`]) || '').trim();
    if (!parentSha) continue; // root commit — no parent state to have been green

    for (const node of touchedNodes) {
      // CI-green approximation: the parent must be on the mainline first-parent chain.
      if (!firstParentMain.has(parentSha)) {
        exclNotFirstParent++;
        continue;
      }
      const tally = nodeTallyAtParent(parentSha);
      if (tally === null) {
        exclNoParentLock++; // no committed lock at the parent — nothing was verified
        continue;
      }
      const t = tally.get(node);
      if (!t || t.total === 0) {
        exclUncoveredAtParent++; // node had no committed verdict — not "green", just uncovered
        continue;
      }
      if (t.refused > 0) {
        exclRefusedAtParent++; // the reviewer ALREADY refused this node — the healthy case
        continue;
      }
      // Green at the parent (>=1 committed verdict, none refused) and the fix touched it.
      candidates.push({ sha, node, parentSha, subject });
    }
  }

  // ---- output -------------------------------------------------------------------
  out(`Candidates (${candidates.length}):`);
  if (candidates.length === 0) {
    out('  (none in the visible mainline history)');
  } else {
    for (const c of candidates) {
      out(
        `  ${c.sha.slice(0, 12)} fixed ${c.node} — parent lock had no refusal for it (escape candidate for triage)`,
      );
      out(`      parent ${c.parentSha.slice(0, 12)} was green here · ${c.subject}`);
    }
  }
  out('');

  out('Join breakdown (per commit × touched node — auditable, not a score):');
  out(`  fix-flavored commits scanned                 ${fixCommits} (of ${totalCommits} on ${MAINLINE_REF})`);
  out(`  fix commits touching a graph-covered node    ${fixTouchingCoveredNode}`);
  out(`  → escape candidates (green at parent)        ${candidates.length}`);
  out(`  → excluded: parent not on first-parent chain ${exclNotFirstParent} (CI-green approximation unmet)`);
  out(`  → excluded: no committed lock at parent      ${exclNoParentLock}`);
  out(`  → excluded: node uncovered/unverified there  ${exclUncoveredAtParent} (no committed verdict to be green)`);
  out(`  → excluded: parent lock DID refuse the node  ${exclRefusedAtParent} (reviewer already caught it — healthy)`);

  emitFooter();
}

function emitFooter() {
  out('');
  out('CI-green is APPROXIMATED by "the parent is on the mainline first-parent chain".');
  out('A full CI-status join needs the GitHub Actions API — out of scope for an offline scan.');
  out('');
  out('— honesty labels —');
  out('UNDERCOUNTS: the deterministic verdict lock is local + gitignored — retroactively');
  out('  INVISIBLE in history — so this scan sees ONLY LLM refusals in history and therefore');
  out('  UNDERCOUNTS; and the live relation-conformance check leaves no lock trace.');
  out('OVERCOUNTS: not every fix-commit fixes a defect (docs, tests, refactors, and typo');
  out('  fixes all match the fix vocabulary), so some candidates are not real escapes.');
  out('candidates for human triage, never a gate.');
  out('This is a triage STREAM, NEVER a gate, NEVER a metric.');
}

main();

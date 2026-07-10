#!/usr/bin/env node
// decision-load — DOGFOOD meter. Read-only over git history. NEVER writes the lock
// or any graph file. No deps.
//
// WHAT: counts decision-shaped events recorded in git history and reports them as a
// per-week arrival-rate (λ) table plus a capacity proxy (median closed decisions per
// active week). The four event streams — each an observable trace of an architectural
// decision — are:
//   aspects  : an aspect definition file added or edited under .yggdrasil/aspects/
//              (distinct aspect id per commit — one authoring decision per aspect)
//   status   : an aspect's `status:` value line CHANGED (draft/advisory/enforced) —
//              a governance/enforcement decision
//   suppress : a new inline `yg-suppress` waiver comment added in source — a
//              deliberate, user-approved exception decision
//   log      : a new `yg log add` entry (a `## [timestamp]` header) in a node log —
//              a captured business/why decision
//
// WHY: this is the wave-2 λ re-baseline input. It measures how fast architectural
// decisions arrive (λ) and how many the team actually closes per active week (the
// capacity proxy), so decision backlog can be reasoned about.
//
// HONESTY (RZ-16): every number here is a PROXY derived from git-observable artifacts.
// It stands in until the advise-decisions register exists to record decisions
// directly; the register is the ground truth, this meter is the interim estimate.
// The proxy over-counts where one decision leaves several traces and under-counts a
// decision that left no git trace — the breakdown below is printed so the composition
// is auditable rather than a single opaque figure.
//
// DETERMINISM: runs under plain Node, so Date is available. To keep the λ table
// reproducible, "now" is pinned to the latest commit date (override with
// YG_DECISION_NOW=<ISO8601>). Weeks are Monday-anchored in UTC.

import { execFileSync } from 'node:child_process';

const out = (m = '') => process.stdout.write(m + '\n');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });

// ---- "now" pin (reproducibility) ------------------------------------------------
const latestCommitISO = git(['log', '-1', '--format=%cI']).trim();
const nowSource = process.env.YG_DECISION_NOW ? 'env YG_DECISION_NOW' : 'latest commit date';
const NOW_ISO = process.env.YG_DECISION_NOW || latestCommitISO;

// ---- week bucketing (Monday-anchored, UTC) --------------------------------------
function mondayUTC(iso) {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const offset = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
}
const weekKey = (iso) => mondayUTC(iso).toISOString().slice(0, 10);

// ---- git parsing helpers --------------------------------------------------------
const SENT = '__YGDL__';
const HEADER = new RegExp('^' + SENT + '([0-9a-f]{7,40})\\|(.+)$');

// Commits touching the given pathspecs, with their changed file list (adds/mods).
function commitsWithFiles(pathspecs) {
  const raw = git([
    'log',
    '--reverse',
    `--format=${SENT}%H|%cI`,
    '--name-only',
    '--diff-filter=AMR',
    '--',
    ...pathspecs,
  ]);
  const commits = [];
  let curr = null;
  for (const line of raw.split('\n')) {
    const m = line.match(HEADER);
    if (m) {
      curr = { sha: m[1], dateISO: m[2], files: [] };
      commits.push(curr);
    } else if (curr && line.trim() !== '') {
      curr.files.push(line.trim());
    }
  }
  return commits;
}

// Commits (with full patch text) matching a pickaxe regex over the given pathspecs.
function commitsWithPatch(pickaxeRegex, pathspecs) {
  const raw = git([
    'log',
    '--reverse',
    `--format=${SENT}%H|%cI`,
    '-p',
    '-G',
    pickaxeRegex,
    '--',
    ...pathspecs,
  ]);
  const commits = [];
  let curr = null;
  let buf = [];
  const flush = () => {
    if (curr) {
      curr.patch = buf.join('\n');
      commits.push(curr);
    }
    buf = [];
  };
  for (const line of raw.split('\n')) {
    const m = line.match(HEADER);
    if (m) {
      flush();
      curr = { sha: m[1], dateISO: m[2] };
    } else {
      buf.push(line);
    }
  }
  flush();
  return commits;
}

// Added lines in a patch (excluding the `+++ b/...` file headers).
function addedLines(patch) {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

// ---- event collectors (each returns an array of ISO commit dates) ---------------

// aspects: distinct aspect id per commit under .yggdrasil/aspects/.
function aspectEvents() {
  const events = [];
  for (const c of commitsWithFiles(['.yggdrasil/aspects/'])) {
    const ids = new Set();
    for (const f of c.files) {
      const m = f.match(/^\.yggdrasil\/aspects\/([^/]+)\//);
      if (m) ids.add(m[1]);
    }
    for (let i = 0; i < ids.size; i++) events.push(c.dateISO);
  }
  return events;
}

// status: a `status:` value line whose value changed within one yg-aspect.yaml section.
function statusChangeEvents() {
  const events = [];
  for (const c of commitsWithPatch('status:', [':(glob).yggdrasil/aspects/**/yg-aspect.yaml'])) {
    // Split into per-file sections; a status flip is a removed + added status line
    // with different values inside the same section.
    const sections = c.patch.split(/^diff --git /m);
    for (const sec of sections) {
      let oldV = null;
      let newV = null;
      for (const line of sec.split('\n')) {
        let m = line.match(/^-status:\s*(\S+)/);
        if (m) oldV = m[1];
        m = line.match(/^\+status:\s*(\S+)/);
        if (m) newV = m[1];
      }
      if (oldV !== null && newV !== null && oldV !== newV) events.push(c.dateISO);
    }
  }
  return events;
}

// suppress: a newly-added inline yg-suppress waiver comment in source. Excludes the
// graph, docs, rules templates, tests/fixtures, and the feature's own implementation,
// where the token appears as prose, data, or the code that parses it — not as a waiver.
function suppressEvents() {
  const pathspecs = [
    '.',
    ':(exclude).yggdrasil/**',
    ':(exclude)docs/**',
    ':(exclude)source/cli/src/templates/**',
    ':(exclude)source/cli/tests/**',
    ':(exclude)source/cli/src/ast/suppress.ts',
    ':(exclude)source/cli/src/portal/api/suppress-scan.ts',
    ':(exclude).plans/**',
    ':(exclude).superpowers/**',
    ':(exclude).temp/**',
    ':(exclude)CHANGELOG.md',
    ':(exclude)README.md',
  ];
  // An actual marker is a COMMENT that starts with yg-suppress — distinguishing it
  // from a string literal / regex that merely contains the token.
  const MARK = /^\s*(?:\/\/+|#+|--|<!--|;+|\/\*+|\*)\s*yg-suppress/;
  const events = [];
  for (const c of commitsWithPatch('yg-suppress', pathspecs)) {
    for (const l of addedLines(c.patch)) {
      if (MARK.test(l)) events.push(c.dateISO);
    }
  }
  return events;
}

// log: each distinct `## [timestamp]` entry header ever added to any node log.
// Deduped by the entry's own timestamp (an entry re-added when a log file is moved
// is the SAME decision, not a new one), and dated at that timestamp — the moment the
// decision was logged — rather than at commit time, which is both more faithful and
// independent of rebase/commit timing. Falls back to the commit date if a header's
// bracket content is not a parseable date.
function logEntryEvents() {
  const seen = new Set();
  const events = [];
  for (const c of commitsWithPatch('^## \\[', [':(glob).yggdrasil/model/**/log.md'])) {
    for (const l of addedLines(c.patch)) {
      const m = l.match(/^## \[([^\]]+)\]/);
      if (!m) continue;
      const ts = m[1];
      if (seen.has(ts)) continue;
      seen.add(ts);
      events.push(Number.isNaN(new Date(ts).getTime()) ? c.dateISO : ts);
    }
  }
  return events;
}

// ---- assemble -------------------------------------------------------------------
const streams = {
  aspects: aspectEvents(),
  status: statusChangeEvents(),
  suppress: suppressEvents(),
  log: logEntryEvents(),
};

out('decision-load — decision-shaped events per week (dogfood proxy meter)');
out(
  `Reproducible: "now" pinned to ${NOW_ISO} (source: ${nowSource}); weeks Monday-anchored, UTC.`,
);
out('');

const total = Object.values(streams).reduce((a, s) => a + s.length, 0);
out('Event streams counted (a decision leaves an observable git trace):');
for (const [k, v] of Object.entries(streams)) out(`  ${k.padEnd(9)} ${v.length}`);
out(`  ${'TOTAL'.padEnd(9)} ${total}`);
out('');

if (total === 0) {
  out('No decision events in the visible history (a shallow clone shows only HEAD).');
  out('[RZ-16] Proxy meter: counts are a git-derived estimate, valid until the');
  out('        advise-decisions register records decisions directly.');
  process.exit(0);
}

// Bucket per week, per stream.
const perWeek = new Map(); // weekKey -> {aspects,status,suppress,log,total}
const touch = (wk) => {
  if (!perWeek.has(wk)) perWeek.set(wk, { aspects: 0, status: 0, suppress: 0, log: 0, total: 0 });
  return perWeek.get(wk);
};
for (const [name, evs] of Object.entries(streams)) {
  for (const iso of evs) {
    const row = touch(weekKey(iso));
    row[name]++;
    row.total++;
  }
}

// Calendar range: earliest event week .. "now" week (inclusive), one row per week.
const weekKeys = [...perWeek.keys()].sort();
const firstMonday = mondayUTC(weekKeys[0]);
const nowMonday = mondayUTC(NOW_ISO);
const lastMonday = nowMonday > firstMonday ? nowMonday : mondayUTC(weekKeys[weekKeys.length - 1]);
const rows = [];
for (let d = new Date(firstMonday); d <= lastMonday; d.setUTCDate(d.getUTCDate() + 7)) {
  const wk = d.toISOString().slice(0, 10);
  rows.push([wk, perWeek.get(wk) || { aspects: 0, status: 0, suppress: 0, log: 0, total: 0 }]);
}

// λ table.
out('Per-week decision arrivals (λ table):');
out('  week (Mon)   aspc  stat  supp   log  TOTAL');
const maxTotal = Math.max(...rows.map(([, r]) => r.total), 1);
for (const [wk, r] of rows) {
  const bar = '#'.repeat(Math.round((r.total / maxTotal) * 24));
  out(
    `  ${wk}  ${String(r.aspects).padStart(4)}  ${String(r.status).padStart(4)}  ` +
      `${String(r.suppress).padStart(4)}  ${String(r.log).padStart(4)}  ${String(r.total).padStart(5)}  ${bar}`,
  );
}
out('');

// Metrics.
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round2 = (x) => Math.round(x * 100) / 100;

const activeCounts = rows.map(([, r]) => r.total).filter((t) => t > 0);
const calendarWeeks = rows.length;
const activeWeeks = activeCounts.length;
const lambdaActive = round2(total / activeWeeks);
const lambdaCalendar = round2(total / calendarWeeks);
const capacityProxy = median(activeCounts);
const trailing = rows.slice(-4).map(([, r]) => r.total);
const lambdaRecent = round2(trailing.reduce((a, b) => a + b, 0) / trailing.length);

out('Summary:');
out(`  total decision events            ${total}`);
out(`  calendar weeks (first .. now)    ${calendarWeeks}`);
out(`  active weeks (>=1 decision)      ${activeWeeks}`);
out(`  λ  (mean / active week)          ${lambdaActive}`);
out(`  λ  (mean / calendar week)        ${lambdaCalendar}`);
out(`  λ  (trailing 4 calendar weeks)   ${lambdaRecent}`);
out(`  capacity proxy (median / active week, closed decisions)   ${capacityProxy}`);
out('');
out('[RZ-16] Proxy meter: every figure above is a git-derived ESTIMATE of decision');
out('        load, valid until the advise-decisions register records decisions');
out('        directly. The register is ground truth; this is the interim proxy.');

process.exit(0);

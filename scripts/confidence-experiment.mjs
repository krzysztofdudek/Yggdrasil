#!/usr/bin/env node
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ RESULT — NEGATIVE (NO-BUILD). Do NOT silently re-run this expecting a       │
// │ different answer; re-run ONLY on a materially different corpus (see below). │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Run once over the LLM drill corpus (28 cases, 12 LLM aspects, provider
// claude-code / tier standard, keyless). Measured:
//   * Brier score = 0.0027, log-loss = 0.0450
//   * Reliability curve: DEGENERATE — all 28 leg-B confidences were near-constant
//     (~0.96) and fell in the single top bin [0.8,1.0]; the other four bins were
//     empty; 28/28 verdicts were correct.
//   * Verdict flip-rate (leg A vs leg B): 0/28
//   * Confidence-field parse-failure rate: 0/28
//
// DECISION: NO confidence channel was built. Deciding condition — a monotone
// confidence→correctness reliability curve could NOT be demonstrated: the
// confidence has near-zero variance and the drill dev-set is a REGRESSION FLOOR
// (author-visible fixtures, answered correctly by construction) with NO error
// cases, so there is nothing for the confidence to discriminate. The very low
// Brier is the improper-metric trap (an "easy", all-correct corpus), not evidence
// of calibration. Parse-failure 0% and flip-rate 0% both pass — asking for the
// confidence is cheap and non-perturbing — but those two clean results do not
// substitute for the missing calibration signal.
//
// RE-EVALUATE ONLY IF a corpus exists that contains cases the judge SOMETIMES GETS
// WRONG (real judge errors) AND produces a spread of confidences across the range —
// only such a corpus can show whether lower confidence predicts higher error. Until
// then the channel stays unbuilt. No `llm/` file was changed by this experiment.
//
// confidence-experiment (C6.4) — judge-confidence EXPERIMENT over the LLM drill
// corpus. It measures whether the reviewer's SELF-REPORTED confidence tracks the
// correctness of its verdict, and whether ASKING for a confidence perturbs the
// verdict. It decides nothing on its own: it prints four measurements
// (Brier + log-loss, a 5-bin reliability table, verdict flip-rate A-vs-B, and the
// confidence-field parse-failure rate); a human evaluates the signal.
//
// READ-ONLY w.r.t. the repo: it NEVER writes the lock, the events sidecar, the
// drill-results sidecar, or any graph file. The only side effect is spawning the
// reviewer CLI in a temp cwd (exactly as the production provider does).
//
// HOLDOUT HYGIENE: it prints only LABELS, short content HASHES, verdicts, and
// AGGREGATE numbers — NEVER the content of any drill case. This is the same
// sealing `yg drill` uses (regression fixtures are visible to the author by
// definition, so a leak here would be worthless anyway — but the discipline is
// uniform).
//
// PRODUCTION PARITY: it does not hand-rebuild the reviewer prompt. It imports the
// REAL prompt builder (`buildPairPrompt`), the REAL parse choke point
// (`parseAspectResponse`), the REAL tier resolver (`selectTierForAspect`, which
// carries the yg-secrets overlay via loadGraph), and the REAL provider factory
// (`createLlmProvider`). Leg A is the current production prompt; leg B is that
// same prompt plus ONE appended line asking for a 0-1 confidence — the suffix is
// constructed HERE, not in llm/prompt.ts (that is the BUILD branch, not this).
//
// The CLI source is TypeScript that ships bundled (tsup), so the individual
// modules are not importable from dist. This script imports the .ts source
// directly under Node's native type support: it re-execs itself with
// --experimental-transform-types (needed for parameter properties / enums in the
// graph loader) and registers a tiny resolve hook that remaps the source's
// `.js` import specifiers to the on-disk `.ts` files. No source file is modified.

import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Bootstrap: ensure Node's TS transform is active, then load the resolve hook ──
if (!process.execArgv.some((a) => a.includes('experimental-transform-types')) && !process.env.__CONF_EXP_REEXEC) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', self, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __CONF_EXP_REEXEC: '1' } },
  );
  process.exit(r.status ?? 1);
}

const { register } = await import('node:module');
// Resolve hook (runs in its own module thread): when a source file imports
// './x.js' but only './x.ts' exists on disk, resolve to the .ts. Pure string ops,
// no regex, so it survives data-URL embedding cleanly.
const HOOK_SRC = [
  "import { existsSync } from 'node:fs';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  'export async function resolve(spec, ctx, next) {',
  "  const rel = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('file:');",
  "  if (rel && spec.endsWith('.js')) {",
  '    try {',
  '      const jsPath = fileURLToPath(new URL(spec, ctx.parentURL));',
  '      if (!existsSync(jsPath)) {',
  "        const tsPath = jsPath.slice(0, -3) + '.ts';",
  '        if (existsSync(tsPath)) return { url: pathToFileURL(tsPath).href, shortCircuit: true };',
  '      }',
  '    } catch { /* fall through to default resolution */ }',
  '  }',
  '  return next(spec, ctx);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SRC));

// ── Repo layout ──
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
const SRC = path.join(ROOT, 'source', 'cli', 'src');
const ASPECTS_DIR = path.join(ROOT, '.yggdrasil', 'aspects');

// ── Import the REAL CLI internals (production parity) ──
const { loadGraph } = await import(path.join(SRC, 'core', 'graph-loader.ts'));
const { buildPairPrompt, assembledPromptChars, PROMPT_FORMAT_REV, DEFAULT_MAX_PROMPT_CHARS } = await import(
  path.join(SRC, 'llm', 'prompt.ts')
);
const { parseAspectResponse } = await import(path.join(SRC, 'llm', 'cli-base.ts'));
const { selectTierForAspect } = await import(path.join(SRC, 'core', 'tier-selection.ts'));
await import(path.join(SRC, 'llm', 'claude-code.ts')); // registers the 'claude-code' provider
const { createLlmProvider } = await import(path.join(SRC, 'llm', 'provider.ts'));

const out = (m = '') => process.stdout.write(m + '\n');
const err = (m = '') => process.stderr.write(m + '\n');

// ── The drill fixed node template — copied verbatim from core/drill-runner.ts
//    (drillNodeDescription) so the prompt is byte-identical to `yg drill`. ──
const drillNodeDescription = (aspectId) =>
  `Drill case corpus for aspect '${aspectId}' — a synthetic fixture exercising the rule, not a graph node.`;

// ── Leg-B suffix: ONE appended line requesting a 0-1 confidence. Constructed here,
//    NOT in llm/prompt.ts. It re-states the JSON shape so the confidence field has
//    a fair chance of appearing; parsing it is exactly what we are measuring. ──
const CONFIDENCE_SUFFIX =
  'Additionally, in the SAME JSON object include a "confidence" field: a number from 0 to 1 giving your probability that the "satisfied" verdict above is correct (1 = certain, 0.5 = a coin-flip) — respond with {"satisfied": true|false, "reason": "...", "confidence": <number 0-1>}.';

const short = (h) => h.slice(0, 8);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Corpus discovery (filesystem — independent of the lock). One case per FILE
//    under a violates-*/satisfies-* directory; .md and yg-aspect.yaml are never
//    cases. Mirrors core/drill-runner.ts discoverDrillCases. ──
function walkFiles(base) {
  const acc = [];
  const rec = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, e.name);
      if (e.isDirectory()) rec(child);
      else acc.push(child);
    }
  };
  rec(base);
  return acc;
}

function discoverCases(aspectId) {
  const base = path.join(ASPECTS_DIR, aspectId, 'drills');
  if (!existsSync(base)) return [];
  const cases = [];
  for (const abs of walkFiles(base)) {
    const relToBase = path.relative(base, abs).split(path.sep).join('/');
    const firstSeg = relToBase.split('/')[0];
    const expect = firstSeg.startsWith('violates-') ? 'refused' : firstSeg.startsWith('satisfies-') ? 'satisfied' : null;
    if (expect === null) continue;
    const baseName = path.basename(abs);
    if (baseName === 'yg-aspect.yaml') continue;
    if (baseName.toLowerCase().endsWith('.md')) continue;
    const ext = path.extname(relToBase);
    const label = ext.length > 0 ? relToBase.slice(0, -ext.length) : relToBase;
    const relToRoot = path.relative(ROOT, abs).split(path.sep).join('/');
    cases.push({ aspectId, label, expect, file: relToRoot });
  }
  cases.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return cases;
}

// ── Reviewer invocation: replicate the cli-base spawn to CAPTURE the raw stdout
//    (the production provider parses and discards it; leg B needs it for the
//    confidence field). Uses the REAL provider's binary/buildArgs/stdinMode, so the
//    call mechanics are production-identical; the verdict is read with the REAL
//    parseAspectResponse. ──
function rawInvoke(provider, prompt, timeout = 300_000) {
  return new Promise((resolve) => {
    const args = provider.stdinMode ? provider.buildArgs('') : provider.buildArgs(prompt);
    const child = spawn(provider.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      cwd: tmpdir(),
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, raw: '', code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !killed && code === 0, raw: stdout, code, stderr });
    });
    if (provider.stdinMode) {
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// A "real verdict" = the provider exited cleanly AND the shared parser produced a
// non-provider disposition. A provider errorSource (unparseable / infra) is an
// UNKNOWN, never a vote and never a calibration point.
function verdictOf(inv) {
  if (!inv.ok) return { real: false, satisfied: null, infra: true };
  const parsed = parseAspectResponse(inv.raw);
  if (!parsed || parsed.errorSource === 'provider') return { real: false, satisfied: null, infra: true };
  return { real: true, satisfied: parsed.satisfied === true, infra: false };
}

// Tolerant confidence parse over the RAW leg-B reply. Finds `confidence` followed
// by a number (JSON `"confidence": 0.9`, or `confidence = 90%`, etc.). Takes the
// LAST match so a stray "confidence" inside the reason prose cannot mask the real
// field that follows it. Normalizes an obvious percentage (a `%` suffix, or a bare
// value > 1) to [0,1] and clamps. parseOk = a number was found.
function parseConfidence(raw) {
  const re = /["']?confidence["']?\s*[:=]\s*["']?(-?\d+(?:\.\d+)?|-?\.\d+)\s*(%?)/gi;
  let m;
  let last = null;
  while ((m = re.exec(raw)) !== null) last = m;
  if (last === null) return { ok: false, value: null };
  let v = parseFloat(last[1]);
  if (!Number.isFinite(v)) return { ok: false, value: null };
  const pct = last[2] === '%' || v > 1.5;
  if (pct) v = v / 100;
  v = Math.max(0, Math.min(1, v));
  return { ok: true, value: v };
}

// ── Build the corpus ──
const graph = await loadGraph(ROOT);
const reviewer = graph.config.reviewer;
if (!reviewer) {
  err('No reviewer configured in yg-config.yaml — cannot run the experiment.');
  process.exit(1);
}

const llmAspects = graph.aspects.filter((a) => a.reviewer?.type === 'llm');
const corpus = [];
for (const aspect of llmAspects) {
  const cases = discoverCases(aspect.id);
  if (cases.length === 0) continue;
  const tierRes = selectTierForAspect(aspect, reviewer);
  if (!tierRes.ok) {
    err(`skip ${aspect.id}: ${tierRes.error.what}`);
    continue;
  }
  for (const c of cases) corpus.push({ ...c, aspect, tier: tierRes.tier, tierName: tierRes.tierName });
}

if (corpus.length === 0) {
  err('No LLM drill cases found — nothing to measure.');
  process.exit(1);
}

// Optional cap for a cheap smoke test (e.g. CONF_EXP_LIMIT=1). Unset ⇒ full corpus.
const LIMIT = Number(process.env.CONF_EXP_LIMIT || 0);
if (LIMIT > 0) corpus.length = Math.min(corpus.length, LIMIT);

// Provider cache by tier name (all aspects here resolve to the same default tier,
// but resolve/cache per tier to stay faithful).
const providerByTier = new Map();
const providerFor = (tierName, tier) => {
  if (!providerByTier.has(tierName)) providerByTier.set(tierName, createLlmProvider(tier));
  return providerByTier.get(tierName);
};

// ── Budget (printed BEFORE the first reviewer call — drill-runner parity) ──
const CONSENSUS = 1; // each leg is one call; the standard tier is consensus 1
const LEGS = 2;
const budget = corpus.length * LEGS * CONSENSUS;
out('confidence-experiment (C6.4) — judge self-reported confidence vs correctness');
out('');
out(
  `BUDGET: ${budget} reviewer call(s) — ${corpus.length} case(s) x ${LEGS} legs x consensus ${CONSENSUS} ` +
    `(provider claude-code, tier standard — keyless, $0).`,
);
out(`PROMPT_FORMAT_REV=${PROMPT_FORMAT_REV} (leg A = production prompt; leg B = +1 confidence line, unbumped).`);
out('ollama leg: SKIPPED — named residual (no active local-model tier; the ollama block in yg-secrets.yaml is commented out).');
out('');
err(`Starting ${budget} reviewer calls (concurrency ${process.env.CONF_EXP_CONC || 4})...`);

// ── Assemble one case's leg-A prompt (faithful to drill-runner reviewOneUnit) ──
function legAPrompt(item) {
  const aspect = item.aspect;
  const contentArt = (aspect.artifacts || []).find((a) => a.filename === 'content.md');
  const content = contentArt?.content ?? '';
  const references = (aspect.references ?? []).map((ref) => {
    const abs = path.resolve(ROOT, ref.path);
    const bytes = existsSync(abs) ? readFileSync(abs) : Buffer.alloc(0);
    return { path: ref.path, description: ref.description, content: bytes.toString('utf8') };
  });
  const fileAbs = path.resolve(ROOT, item.file);
  const fileBytes = existsSync(fileAbs) ? readFileSync(fileAbs) : Buffer.alloc(0);
  const files = [{ path: item.file, content: fileBytes.toString('utf8') }];
  const promptInput = {
    aspect: { id: aspect.id, description: aspect.description ?? '', content },
    references,
    nodePath: `drill:${aspect.id}`,
    nodeDescription: drillNodeDescription(aspect.id),
    files,
    companions: [],
    suppressedRanges: undefined, // no case in this corpus carries a yg-suppress marker
    scope: aspect.scope,
  };
  const chars = assembledPromptChars(promptInput);
  const limit = item.tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS;
  return { prompt: buildPairPrompt(promptInput), caseHash: sha(fileBytes), chars, overLimit: chars > limit, limit };
}

// ── Run both legs for every case, bounded concurrency ──
const CONC = Number(process.env.CONF_EXP_CONC || 4);
const results = new Array(corpus.length);
let done = 0;

async function runOne(idx) {
  const item = corpus[idx];
  const provider = providerFor(item.tierName, item.tier);
  const a = legAPrompt(item);
  const res = {
    aspectId: item.aspectId,
    label: item.label,
    expect: item.expect,
    expectedSatisfied: item.expect === 'satisfied',
    caseHash: a.caseHash,
    tier: item.tierName,
  };
  if (a.overLimit) {
    res.skipped = `prompt ${a.chars} > limit ${a.limit}`;
    results[idx] = res;
    done++;
    err(`  [${done}/${corpus.length}] ${item.aspectId}/${item.label} — SKIPPED (over prompt limit)`);
    return;
  }
  const legBFull = a.prompt + '\n\n' + CONFIDENCE_SUFFIX;
  const invA = await rawInvoke(provider, a.prompt);
  const invB = await rawInvoke(provider, legBFull);
  const vA = verdictOf(invA);
  const vB = verdictOf(invB);
  const conf = vB.real ? parseConfidence(invB.raw) : { ok: false, value: null };
  res.legA = vA;
  res.legB = vB;
  res.conf = conf;
  results[idx] = res;
  done++;
  const av = vA.infra ? 'infra' : vA.satisfied ? 'satisfied' : 'refused';
  const bv = vB.infra ? 'infra' : vB.satisfied ? 'satisfied' : 'refused';
  const cf = conf.ok ? conf.value.toFixed(2) : 'NO-PARSE';
  err(`  [${done}/${corpus.length}] ${item.aspectId}/${item.label} (case ${short(a.caseHash)}) A=${av} B=${bv} conf=${cf}`);
}

async function runPool() {
  let next = 0;
  const workers = new Array(Math.min(CONC, corpus.length)).fill(0).map(async () => {
    while (true) {
      const idx = next++;
      if (idx >= corpus.length) return;
      await runOne(idx);
    }
  });
  await Promise.all(workers);
}

await runPool();

// ── Metrics ──
// Calibration set: leg-B cases with a real verdict AND a parsed confidence.
const calib = results.filter((r) => r.legB && r.legB.real && r.conf && r.conf.ok);
const outcome = (r) => (r.legB.satisfied === r.expectedSatisfied ? 1 : 0);

let brier = null;
let logloss = null;
if (calib.length > 0) {
  let sBrier = 0;
  let sLog = 0;
  for (const r of calib) {
    const y = outcome(r);
    const p = r.conf.value;
    sBrier += (p - y) ** 2;
    const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
    sLog += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  brier = sBrier / calib.length;
  logloss = sLog / calib.length;
}

// 5-bin reliability.
const bins = [
  { lo: 0.0, hi: 0.2, n: 0, sumP: 0, correct: 0 },
  { lo: 0.2, hi: 0.4, n: 0, sumP: 0, correct: 0 },
  { lo: 0.4, hi: 0.6, n: 0, sumP: 0, correct: 0 },
  { lo: 0.6, hi: 0.8, n: 0, sumP: 0, correct: 0 },
  { lo: 0.8, hi: 1.0, n: 0, sumP: 0, correct: 0 },
];
for (const r of calib) {
  const p = r.conf.value;
  const bi = Math.min(4, Math.floor(p / 0.2));
  bins[bi].n++;
  bins[bi].sumP += p;
  bins[bi].correct += outcome(r);
}

// Flip-rate: cases where BOTH legs produced a real verdict.
const bothReal = results.filter((r) => r.legA && r.legB && r.legA.real && r.legB.real);
const flips = bothReal.filter((r) => r.legA.satisfied !== r.legB.satisfied);
const flipRate = bothReal.length > 0 ? flips.length / bothReal.length : null;

// Parse-failure: over leg-B cases with a real verdict, fraction where confidence
// did not parse.
const legBReal = results.filter((r) => r.legB && r.legB.real);
const parseFail = legBReal.filter((r) => !(r.conf && r.conf.ok));
const parseFailRate = legBReal.length > 0 ? parseFail.length / legBReal.length : null;

// Infra counts.
const infraA = results.filter((r) => r.legA && r.legA.infra).length;
const infraB = results.filter((r) => r.legB && r.legB.infra).length;
const skipped = results.filter((r) => r.skipped).length;

// Monotonicity over NON-EMPTY bins.
const nonEmpty = bins.filter((b) => b.n > 0);
let monotone = null;
if (nonEmpty.length >= 2) {
  monotone = true;
  for (let i = 1; i < nonEmpty.length; i++) {
    if (nonEmpty[i].correct / nonEmpty[i].n < nonEmpty[i - 1].correct / nonEmpty[i - 1].n - 1e-9) monotone = false;
  }
}

const pct = (x) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%');
const f3 = (x) => (x === null ? 'n/a' : x.toFixed(4));

// ── Report ──
out('================ RESULTS ================');
out('');
out(`Cases run: ${results.length}   leg-B real verdicts: ${legBReal.length}   calibration points (real verdict + parsed confidence): ${calib.length}`);
out(`Infra/unparseable (excluded, unknown != vote): leg A = ${infraA}, leg B = ${infraB}${skipped ? `; over-prompt-limit skipped = ${skipped}` : ''}`);
out('');
out('(i) SCORING (strictly proper — never accuracy-at-threshold):');
out(`    Brier score  = ${f3(brier)}   (0 = perfect, 0.25 = always-0.5, higher = worse)`);
out(`    Log-loss     = ${f3(logloss)}`);
out('');
out('(ii) 5-BIN RELIABILITY TABLE (confidence in the verdict vs empirical correctness):');
out('     bin            n   mean_conf   emp_correct');
for (const b of bins) {
  const meanP = b.n > 0 ? (b.sumP / b.n).toFixed(3) : '  -  ';
  const empC = b.n > 0 ? (b.correct / b.n).toFixed(3) : '  -  ';
  const range = `[${b.lo.toFixed(1)},${b.hi.toFixed(1)}${b.hi === 1.0 ? ']' : ')'}`;
  out(`     ${range.padEnd(12)} ${String(b.n).padStart(3)}   ${String(meanP).padStart(7)}   ${String(empC).padStart(9)}`);
}
out(`     monotone non-decreasing across non-empty bins? ${monotone === null ? 'UNEVALUABLE (<2 non-empty bins)' : monotone ? 'YES' : 'NO'}`);
out('');
out('(iii) VERDICT FLIP-RATE A vs B (suffix must NOT change verdicts):');
out(`     flips ${flips.length} / ${bothReal.length} both-real cases = ${pct(flipRate)}`);
if (flips.length > 0) {
  for (const r of flips) {
    out(`       flip: ${r.aspectId}/${r.label} (case ${short(r.caseHash)})  A=${r.legA.satisfied ? 'satisfied' : 'refused'} -> B=${r.legB.satisfied ? 'satisfied' : 'refused'}`);
  }
}
out('');
out('(iv) CONFIDENCE-FIELD PARSE-FAILURE RATE:');
out(`     no-parse ${parseFail.length} / ${legBReal.length} leg-B real verdicts = ${pct(parseFailRate)}`);
out('');
out('---------------- per-aspect corpus (labels + counts only; no case content) ----------------');
const byAspect = new Map();
for (const r of results) {
  if (!byAspect.has(r.aspectId)) byAspect.set(r.aspectId, { total: 0, viol: 0, sat: 0 });
  const g = byAspect.get(r.aspectId);
  g.total++;
  if (r.expect === 'refused') g.viol++;
  else g.sat++;
}
for (const [id, g] of [...byAspect.entries()].sort()) {
  out(`  ${id.padEnd(30)} ${g.total} case(s)  (violates ${g.viol}, satisfies ${g.sat})`);
}
out('');
out('---------------- per-case honesty frame (label + hash + verdicts + confidence; NO content) ----------------');
for (const r of results) {
  if (r.skipped) {
    out(`  ${r.aspectId}/${r.label} (case ${short(r.caseHash)})  SKIPPED: ${r.skipped}`);
    continue;
  }
  const av = r.legA.infra ? 'infra' : r.legA.satisfied ? 'satisfied' : 'refused';
  const bv = r.legB.infra ? 'infra' : r.legB.satisfied ? 'satisfied' : 'refused';
  const cf = r.conf && r.conf.ok ? r.conf.value.toFixed(2) : 'NO-PARSE';
  const corr = r.legB.real ? (r.legB.satisfied === r.expectedSatisfied ? 'correct' : 'WRONG') : '-';
  out(`  ${r.aspectId}/${r.label} (case ${short(r.caseHash)})  expect=${r.expect}  A=${av}  B=${bv}  conf=${cf}  [B ${corr}]`);
}
out('');
out('READ-ONLY: no lock / events / drill-results / graph file was written. Only reviewer subprocesses were spawned (temp cwd).');

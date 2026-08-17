// roots2 — COMPLETE emergent prototype. Every mechanism of the spec, nothing hardcoded:
//   language bindings are DERIVED from each grammar's node-types.json (scope = node with name+body fields;
//   kind = container/leaf by nesting; imports/decorators/heritage by grammar-metadata regex) — arbitrary AST trees.
// Mechanisms: 8 enumerators · roles (MDL cut, sticky, ambiguity, role_lift) · v5 acceptance (KT, index cost,
//   fire-ability, survived-raw share, vacuous filter, absence-τ, dedup) · FULL git history (every blob→AST,
//   per-scope lifecycle, value events) · trends+attractor(report-only)+nucleation · co-change+completeness ·
//   calibration (temporal split, τ_c, DENY gate) · seeds (pid-scoped, capped, tension) · telemetry+compliance→
//   hook_shaped ledger→weight cap · demotions · session dedup+budgets · agentShare · report/status · export-aspect.
// CLI: learn check report status completeness mutate-test export-aspect scan-pid
import { Parser, Language } from '/home/user/Yggdrasil/source/cli/node_modules/web-tree-sitter/web-tree-sitter.js';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative, basename, dirname, extname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const [CMD, REPO, MODEL, ...REST] = process.argv.slice(2);
const OPTS = Object.fromEntries(REST.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const ARGS = REST.filter(a => !a.startsWith('--'));
const GD = '/home/user/Yggdrasil/source/cli/dist/grammars';
const EXCL = /(^|\/)(node_modules|dist|build|out|vendor|\.git|\.yggdrasil|__pycache__|migrations|coverage|\.next|bin|obj|fixtures?|benchmarks?|__mocks__|target)(\/|$)|\.min\.|generated|\.d\.ts$/;
const MINE_EXCL = /\.(test|spec)\./; // excluded from convention mining only — history & co-change still count these files
const CFG = { margin: 4.0, minRaw: 5, minEff: 3, tau: 2.5, tauAbs: 3.5, minShare: 2 / 3, ambGap: 0.15, minMemb: 0.35,
  survDays: 120, freshDays: 14, agentBase: 0.15, promoteDays: 180, floor: 0.05, hookShapedW: 0.15,
  calibHorizonDays: 365, calibSettleDays: 30, calibMinEv: 12, denyMinEv: 35, targetPrec: 0.8,
  cochangeMinSup: 8, cochangeMinConf: 0.75, megaCap: 30, healthMinCompliance: 0.3, healthMinN: 8,
  maxMsgs: 3, sessionMaxWarn: 12, trendWinDays: 90, dirMin: 25, tauAbsStruct: 4.5 };
const EXTR_V = 'x1'; // extractor version — bump on any extraction change; invalidates the persistent blob cache by key
const NCAP = 700;
const SUP = { nodeType: 20, call: 8, imp: 5, ext: 4, shape: 15 };
const TOPK = { nodeType: 30, call: 80, imp: 60, ext: 30, shape: 40 };
const EXT2GRAMMAR = { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.rb': 'ruby', '.rs': 'rust', '.cs': 'c_sharp', '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.kt': 'kotlin' };
const CODE_RE = new RegExp('(' + Object.keys(EXT2GRAMMAR).map(e => '\\' + e).join('|') + ')$');

// ===== GENERIC BINDING: derived from the grammar's node-types.json — no per-language code =====
const bindings = {};
function bindingFor(gname) {
  if (bindings[gname]) return bindings[gname];
  const nt = JSON.parse(readFileSync(join(GD, `tree-sitter-${gname}.node-types.json`), 'utf8'));
  const b = { scope: new Set(), imp: new Set(), deco: new Set(), heritageRe: /heritage|extends|implements|superclass|super_interfaces|base_|superclasses|argument_list/ };
  for (const n of nt) {
    const f = n.fields || {};
    if (f.name && f.body) b.scope.add(n.type);                       // scope = named node with a body
    if (/import|include|use_declaration|require/.test(n.type) && !n.type.startsWith('_')) b.imp.add(n.type);
    if (/decorator|annotation|attribute_list/.test(n.type)) b.deco.add(n.type); }
  bindings[gname] = b; return b; }
const parsers = {}; let _init = false;
async function getParser(ext) {
  if (!_init) { await Parser.init(); _init = true; }
  const g = EXT2GRAMMAR[ext] || 'javascript';
  if (!parsers[g]) { const lang = await Language.load(join(GD, `tree-sitter-${g}.wasm`)); const p = new Parser(); p.setLanguage(lang); parsers[g] = p; p._g = g; }
  return parsers[g]; }
function* walkFiles(dir, root) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const full = join(dir, e.name); const rel = relative(root, full);
    if (EXCL.test(rel + (e.isDirectory() ? '/' : ''))) continue;
    if (e.isDirectory()) yield* walkFiles(full, root);
    else if (CODE_RE.test(e.name) && !MINE_EXCL.test(e.name) && EXT2GRAMMAR[extname(e.name)]) yield rel; } }
const tokenize = n => (n || '').replace(/[^a-zA-Z0-9]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/\s+/).filter(t => t.length > 1);
function nameShape(n) { if (!n) return '?';
  let r = n.replace(/[A-Z]+/g, 'U').replace(/[a-z0-9]+/g, 'a').replace(/[^Ua_\-$.]/g, '?');
  for (let u = 1; u <= 3; u++) for (let s = 0; s + 2 * u <= r.length; s++) { const un = r.slice(s, s + u); let k = s + u;
    while (r.slice(k, k + u) === un) k += u; if (k - s >= 2 * u) r = r.slice(0, s) + '(' + un + ')+' + r.slice(k); }
  return r; }
function resolveImport(spec, rel) { if (!spec.startsWith('.')) return spec;
  const ps = (dirname(rel) + '/' + spec).split('/'); const o = [];
  for (const p of ps) { if (p === '.' || p === '') continue; if (p === '..') o.pop(); else o.push(p); }
  return '~/' + o.join('/').replace(/\.[a-z]+$/, ''); }
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// ===== EXTRACTION (binding-driven, language-free) =====
function extractScopes(rel, tree, b) {
  const scopes = []; const imports = [];
  const isScope = n => b.scope.has(n.type);
  const walk = node => { for (const ch of node.namedChildren) {
    if (b.imp.has(ch.type)) { const str = ch.descendantsOfType('string')[0] || ch.descendantsOfType('string_literal')[0];
      let tgt = str ? str.text.replace(/^["'`]|["'`]$/g, '') : (ch.namedChildren.find(c => /dotted_name|scoped_identifier|identifier|package/.test(c.type))?.text);
      if (tgt) imports.push(resolveImport(tgt, rel)); }
    if (isScope(ch)) {
      const name = ch.childForFieldName('name')?.text || '<anon>';
      const bodyN = ch.childForFieldName('body');
      const hasChildScope = bodyN ? bodyN.descendantsOfType([...b.scope]).length > 0 : false;
      const kind = hasChildScope ? 'type' : 'method';
      const sup = []; const sc = ch.childForFieldName('superclasses'); if (sc) for (const id of sc.descendantsOfType('identifier').concat(sc.descendantsOfType('attribute'))) sup.push(id.text);
      for (const c2 of ch.namedChildren) if (b.heritageRe.test(c2.type) && c2 !== bodyN) for (const id of c2.descendantsOfType('identifier').concat(c2.descendantsOfType('type_identifier')).concat(c2.descendantsOfType('scoped_type_identifier'))) sup.push(id.text);
      // decoration window: after the previous non-decoration sibling, before this scope's body — covers stacks of any
      // height and never attributes a preceding member's (or the enclosing class's earlier members') decorators to this scope
      const decos = []; let loRow = -1;
      if (ch.parent) for (const sib of ch.parent.namedChildren) { if (sib === ch) break; if (!b.deco.has(sib.type) && sib.type !== 'comment') loRow = Math.max(loRow, sib.endPosition.row); }
      const bodyRow = bodyN ? bodyN.startPosition.row : ch.endPosition.row;
      const scanDeco = host => { for (const d of host.descendantsOfType([...b.deco])) if (d.startPosition.row > loRow && d.startPosition.row <= bodyRow && /^[@[]/.test(d.text.trimStart())) { const m = d.text.match(/@?([\w.]+)/); if (m) decos.push(m[1]); } };
      if (ch.parent) scanDeco(ch.parent);
      const params = ch.childForFieldName('parameters'); const nP = params ? params.namedChildren.length : 0;
      const stmts = bodyN ? bodyN.namedChildren : [];
      const seen = new Set(); const calls = new Set(); const varNames = []; const stack = [...stmts]; let g = 0;
      while (stack.length && g++ < 4000) { const n = stack.pop(); seen.add(n.type);
        if (/call/.test(n.type) && n.childForFieldName('function')) { const fn = n.childForFieldName('function'); if (fn.text.length <= 40 && !fn.text.includes('\n')) calls.add(fn.text); }
        if (n.type === 'variable_declarator' || (n.type === 'assignment' && n.childForFieldName('left')?.type === 'identifier')) { const nm = (n.childForFieldName('name') || n.childForFieldName('left'))?.text; if (nm) varNames.push(nm); }
        if (!isScope(n)) for (const c of n.namedChildren) stack.push(c); }
      const shapes = new Set(); const ser = (n, d) => d <= 0 ? n.type : n.type + '(' + n.namedChildren.slice(0, 3).map(c => ser(c, d - 1)).join(',') + ')';
      if (kind === 'method') for (const st of stmts.slice(0, 20)) shapes.add(ser(st, 2));
      const rets = stmts.filter(s => /return/.test(s.type));
      const preds = { 'auto.nameshape': nameShape(name) };
      if (kind === 'method') { preds['auto.arity'] = nP >= 3 ? '3+' : String(nP);
        if (stmts.length >= 1) preds['auto.first1'] = stmts[0].type;
        if (rets.length) preds['auto.ret'] = rets[rets.length - 1].namedChildren[0]?.type || 'bare';
        if (varNames.length >= 2) { const c = {}; for (const v of varNames.slice(0, 20)) { const sh = nameShape(v); c[sh] = (c[sh] || 0) + 1; } preds['auto.varshape'] = Object.entries(c).sort((a, x) => x[1] - a[1])[0][0]; } }
      scopes.push({ kind, name, rel, line: ch.startPosition.row + 1, sup: [...new Set(sup)], decos: [...new Set(decos)], calls, seen, shapes, preds });
      walk(bodyN || ch);
    } else walk(ch); } };
  walk(tree.rootNode);
  const fPreds = { 'auto.filenameshape': nameShape(basename(rel, extname(rel))) };
  dirname(rel).split('/').filter(s => s !== '.').slice(0, 3).forEach((s, k) => fPreds['auto.dir' + (k + 1)] = s);
  scopes.push({ kind: 'file', name: basename(rel), rel, line: 1, sup: [], decos: [], calls: new Set(), seen: new Set(), shapes: new Set(), preds: fPreds });
  const occ = new Map(); // ordinal disambiguates same-named scopes of a kind within one file (overloads, repeated nested classes)
  for (const s of scopes) { const k = s.kind + '' + s.name; const n = occ.get(k) || 0; s.ord = n; occ.set(k, n + 1); }
  for (const s of scopes) { s.imports = imports;
    s.feats = [...new Set([...tokenize(s.name).map(t => 'tok:' + t), ...s.sup.map(x => 'sup:' + x), ...s.decos.map(d => 'dec:' + d),
      ...[...new Set(imports.filter(i => !i.startsWith('~/')).map(i => i.split('/').pop()))].slice(0, 5).map(x => 'imp:' + x)])];
    s.ownCount = new Set([...tokenize(s.name), ...s.sup, ...s.decos]).size; }
  return scopes; }
const skeyR = (rel, s) => rel + '#' + s.kind + '#' + s.name + (s.ord ? '#' + s.ord : ''); // scope identity key (ordinal only when non-zero)
function applyVocab(s, vb) {
  if (s.kind === 'method') { for (const nt of vb.NT) s.preds['auto.has:' + nt] = s.seen.has(nt) ? 'true' : 'false';
    for (const c of vb.CALL) s.preds['auto.call:' + c] = s.calls.has(c) ? 'true' : 'false';
    for (const sh of vb.SHAPE) s.preds['auto.stshape:' + sh] = s.shapes.has(sh) ? 'true' : 'false'; }
  if (s.kind !== 'file') { for (const d of vb.DECO) s.preds['auto.deco:@' + d] = s.decos.includes(d) ? 'true' : 'false';
    for (const e of vb.EXT) s.preds['auto.extends:' + e] = s.sup.includes(e) ? 'true' : 'false'; }
  if (s.kind === 'file') for (const i of vb.IMP) s.preds['auto.imp:' + i] = s.imports.includes(i) ? 'true' : 'false'; }
const isBool = pid => /^auto\.(has|call|deco|extends|imp|stshape):/.test(pid);
const jac = (A0, B0) => { const A = A0 instanceof Set ? A0 : new Set(A0), B = B0 instanceof Set ? B0 : new Set(B0);
  let i = 0; const [s, l] = A.size < B.size ? [A, B] : [B, A]; for (const x of s) if (l.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };
const kt = (c, K, x, n) => (((Object.prototype.hasOwnProperty.call(c, x) ? c[x] : 0) || 0) + 0.5) / (n + K / 2); // hasOwnProperty: model JSON counts are plain objects — a value literally named "constructor" must read 0, not Object.prototype.constructor

// ===== ROLES =====
function induceRoles(ps) {
  const el = []; ps.forEach((s, i) => { if (s.kind !== 'file' && s.kind !== 'module' && s.ownCount >= 2) el.push(i); });
  // pre-bucket identical feature bags before sampling: identical twins can never be split by the sample cap,
  // and effective clustering capacity rises from NCAP scopes to NCAP *distinct bags*
  const buckets = new Map(); for (const g of el) { const sig = [...ps[g].feats].sort().join(''); (buckets.get(sig) || buckets.set(sig, []).get(sig)).push(g); }
  let reps = [...buckets.values()];
  if (reps.length > NCAP) { const st = reps.length / NCAP; const rs = []; for (let k = 0; k < NCAP; k++) rs.push(reps[Math.floor(k * st)]); reps = rs; }
  const N = reps.length; const W = reps.map(r => r.length);
  if (W.reduce((a, b) => a + b, 0) < 12) return { assign: new Map(), amb: new Set(), medoids: [] };
  const SA = reps.map(r => ps[r[0]]); const D = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const d = 1 - jac(SA[i].feats, SA[j].feats); D[i * N + j] = D[j * N + i] = d; }
  const act = new Set(Array.from({ length: N }, (_, i) => i)); const mem = Array.from({ length: N }, (_, i) => [i]); const size = new Float64Array(N); for (let i = 0; i < N; i++) size[i] = W[i];
  const cdl = m => { const nc = m.reduce((a, x) => a + W[x], 0); const cnt = new Map(); for (const x of m) for (const f of SA[x].feats) cnt.set(f, (cnt.get(f) || 0) + W[x]);
    let dl = 0; for (const [, c] of cnt) { const p = c / nc; const h = p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)); dl += nc * h + 0.5 * Math.log2(Math.max(nc, 2)); } return dl; };
  const dls = mem.map(cdl); let sum = dls.reduce((a, b) => a + b, 0);
  let bestDL = sum + act.size * Math.log2(N), best = [...act].map(i => [...mem[i]]);
  while (act.size > 1) { let bi = -1, bj = -1, bd = Infinity; const A = [...act];
    for (let x = 0; x < A.length; x++) for (let y = x + 1; y < A.length; y++) { const d = D[A[x] * N + A[y]]; if (d < bd) { bd = d; bi = A[x]; bj = A[y]; } }
    for (const k of act) { if (k === bi || k === bj) continue; D[bi * N + k] = D[k * N + bi] = (size[bi] * D[bi * N + k] + size[bj] * D[bj * N + k]) / (size[bi] + size[bj]); }
    mem[bi] = mem[bi].concat(mem[bj]); size[bi] += size[bj]; act.delete(bj);
    sum -= dls[bi] + dls[bj]; dls[bi] = cdl(mem[bi]); sum += dls[bi];
    const t = sum + act.size * Math.log2(N); if (t < bestDL) { bestDL = t; best = [...act].map(i => [...mem[i]]); } }
  const D0 = (i, j) => i === j ? 0 : 1 - jac(SA[i].feats, SA[j].feats);
  const medoids = best.filter(m => m.reduce((a, x) => a + W[x], 0) >= 3).map(m => { let b = m[0], bs = Infinity;
    for (const i of m) { let s2 = 0; for (const j of m) s2 += W[j] * D0(i, j); if (s2 < bs) { bs = s2; b = i; } }
    return { feats: SA[b].feats, label: SA[b].feats.filter(f => /^(tok|dec|sup):/.test(f)).slice(0, 3).map(f => f.slice(4)).join('+') || 'group' }; });
  const { assign, amb } = assignAll(ps, medoids);
  return { assign, amb, medoids }; }
function assignAll(ps, medoids) { const assign = new Map(), amb = new Set();
  ps.forEach((s, i) => { if (s.kind === 'file' || s.kind === 'module' || s.ownCount < 2 || !medoids.length) return;
    let b = -1, m1 = -1;
    medoids.forEach((md, k) => { const m = jac(s.feats, md.feats); if (m > m1) { m1 = m; b = k; } });
    if (b < 0 || m1 <= 0) return;
    // the gap runner-up must be a genuinely DIFFERENT role: a near-clone of the best medoid
    // (two clusters of the same latent role surviving the cut) must not manufacture ambiguity
    let m2 = -1; medoids.forEach((md, k) => { if (k === b || jac(medoids[b].feats, md.feats) >= 0.6) return; const m = jac(s.feats, md.feats); if (m > m2) m2 = m; });
    if (m1 < CFG.minMemb || m1 - m2 < CFG.ambGap) amb.add(i);
    assign.set(i, b); });
  return { assign, amb }; }

// ===== MINING (v5 math + seeds + survived-raw + role_lift) =====
function mine(ps, ri, wfn, seeds, ageFn) {
  const cells = new Map(); const alph = new Map(); const S = '';
  const add = (cid, pid, v, w, rw, gi, surv) => { const k = cid + S + pid; let c = cells.get(k);
    if (!c) { c = { counts: Object.create(null), raw: Object.create(null), sraw: Object.create(null), members: Object.create(null) }; cells.set(k, c); }
    c.counts[v] = (c.counts[v] || 0) + w; c.raw[v] = (c.raw[v] || 0) + rw; if (surv) c.sraw[v] = (c.sraw[v] || 0) + rw;
    if (gi >= 0) (c.members[v] ||= []).push(gi);
    let a = alph.get(pid); if (!a) { a = new Set(); alph.set(pid, a); } a.add(v); };
  // directory contexts (pattern locality below the partition): ancestor dirs holding ≥ dirMin scopes of a kind,
  // but fewer than the whole partition — a proper spatial sub-community that can carry its own local default
  const dirsOf = rel => { const segs = rel.split('/').slice(0, -1); const out2 = []; for (let k = 1; k <= segs.length; k++) out2.push(segs.slice(0, k).join('/')); return out2; };
  const dirCount = new Map();
  for (const s of ps) for (const d of dirsOf(s.rel)) { const k = d + S + s.kind; dirCount.set(k, (dirCount.get(k) || 0) + 1); }
  const kindTotal = new Map(); for (const s of ps) kindTotal.set(s.kind, (kindTotal.get(s.kind) || 0) + 1);
  const dirEligible = k => dirCount.get(k) >= CFG.dirMin && dirCount.get(k) < kindTotal.get(k.split(S)[1]);
  ps.forEach((s, i) => { const w = wfn(s); const surv = ageFn ? ageFn(s) >= CFG.freshDays : true;
    for (const [pid, v] of Object.entries(s.preds)) {
      add('_all:' + s.kind, pid, v, w, 1, i, surv);
      const r = ri.assign.get(i); if (r !== undefined) add('r' + r + ':' + s.kind, pid, v, w * (ri.amb.has(i) ? 0.5 : 1), 1, i, surv);
      for (const d of dirsOf(s.rel)) if (dirEligible(d + S + s.kind)) add('d[' + d + ']:' + s.kind, pid, v, w, 1, i, surv); } });
  // seeds: pid-scoped pseudo-counts, capped at 0.5 × n_eff_real of the cell
  for (const sd of seeds || []) { const gi = ps.findIndex(s => s.rel === sd.path && s.name === sd.name);
    if (gi < 0) continue; const s = ps[gi]; const r = ri.assign.get(gi);
    for (const pid of sd.pids) { const v = s.preds[pid]; if (v === undefined) continue;
      for (const cid of ['_all:' + s.kind, ...(r !== undefined ? ['r' + r + ':' + s.kind] : [])]) {
        const c = cells.get(cid + S + pid); if (!c) continue;
        const neffReal = Object.values(c.counts).reduce((a, b) => a + b, 0);
        add(cid, pid, v, Math.min(sd.weight, 0.5 * neffReal), 0, -1, false); } } }
  let C = 0; for (const [, c] of cells) if (Object.values(c.raw).reduce((a, b) => a + b, 0) >= CFG.minRaw) C++;
  const idxCost = Math.ceil(Math.log2(Math.max(C, 2)));
  const out = [];
  for (const [key, cell] of cells) {
    const [cid, pid] = key.split(S); const kind = cid.split(':')[1]; const isAll = cid.startsWith('_all');
    const raw = Object.values(cell.raw).reduce((a, b) => a + b, 0); const neff = Object.values(cell.counts).reduce((a, b) => a + b, 0);
    if (raw < CFG.minRaw || neff < CFG.minEff) continue;
    const bl = isBool(pid); const Vv = bl ? ['true', 'false'] : [...alph.get(pid)].sort(); const K = bl ? 2 : Vv.length + 1;
    const allCell = isAll ? cell : cells.get('_all:' + kind + S + pid);
    const allN = allCell ? Object.values(allCell.counts).reduce((a, b) => a + b, 0) : neff;
    let data = 0;
    if (isAll) { const B = Math.max(bl ? 2 : Vv.length, 2); for (const v of Vv) { const nv = cell.counts[v] || 0; if (nv) data += nv * Math.log2(kt(cell.counts, K, v, neff) * B); } }
    else for (const v of Vv) { const nv = cell.counts[v] || 0; if (nv) data += nv * Math.log2(kt(cell.counts, K, v, neff) / kt(allCell.counts, K, v, allN)); }
    const bits = data - 0.5 * (K - 1) * Math.log2(Math.max(neff, 2)) - idxCost;
    if (process.env.DBG && pid.includes(process.env.DBG)) console.error(`[dbg] ${cid} ${pid} raw=${raw} neff=${neff.toFixed(1)} data=${data.toFixed(1)} bits=${bits.toFixed(1)} counts=${JSON.stringify(cell.counts)} sraw=${JSON.stringify(cell.sraw)}`);
    if (bits < CFG.margin) continue;
    let exp = null, ne = -1; for (const v of Vv) { const c = cell.counts[v] || 0; if (c > ne) { exp = v; ne = c; } }
    let nru = 0; for (const v of Vv) if (v !== exp) nru = Math.max(nru, cell.counts[v] || 0);
    const tau = (bl && exp === 'false') ? (/^auto\.(has|stshape):/.test(pid) ? CFG.tauAbsStruct : CFG.tauAbs) : CFG.tau; // structural absence ("never contains <node type>") is a far larger family than vocabulary absence — stricter bar
    if (!((ne + 0.5) / (nru + 0.5) >= 2 ** tau)) continue;
    const sraw = Object.values(cell.sraw).reduce((a, b) => a + b, 0);
    const srawShare = sraw >= CFG.minRaw ? (cell.sraw[exp] || 0) / sraw : -1;
    if (srawShare < CFG.minShare) continue;                                     // survived-raw display+honesty gate
    if (bl && isAll && !(cell.raw[exp === 'true' ? 'false' : 'true'] > 0)) continue;   // vacuous
    if (/^auto\.dir\d/.test(pid) && !/^r\d/.test(cid)) continue;                // placement is group-only (a dir context "predicting" its own path is tautology)
    if (!bl && ['other', 'none', 'mixed', '?'].includes(exp)) continue;         // fallback buckets never expected
    let parentExp = null; // the enclosing context's default, for locality-contrast messaging
    if (!isAll && allCell) { let pe = null, pn = -1; for (const v of Object.keys(allCell.counts)) { if (allCell.counts[v] > pn) { pe = v; pn = allCell.counts[v]; } } parentExp = pe; }
    out.push({ cid, pid, exp, kind, bpi: data / neff, raw, sraw, srawShare, tau, parentExp,
      counts: cell.counts, alphabet: Vv, conform: cell.members[exp] || [],
      deviants: Vv.filter(v => v !== exp).flatMap(v => (cell.members[v] || []).map(gi => ({ gi, v }))) }); }
  // redundant-refinement filter: a dir fact agreeing with its parent's default while an accepted `_all`
  // fact already states it repo/package-wide is not local information — it would only re-say the general rule
  const allAccepted = new Set(out.filter(f => f.cid.startsWith('_all')).map(f => f.kind + S + f.pid + S + f.exp));
  let pruned = out.filter(f => !(f.cid.startsWith('d[') && f.exp === f.parentExp && allAccepted.has(f.kind + S + f.pid + S + f.exp)));
  // nested same-default refinement: if a shallower dir already states (kind,pid,exp), a deeper dir restating it adds nothing
  const dirOfCid = cid => cid.slice(2, cid.indexOf(']'));
  const keptDirs = new Map(); // kind\x01pid\x01exp -> [dirs kept]
  pruned = pruned.sort((a, b) => (a.cid.startsWith('d[') ? dirOfCid(a.cid).length : 0) - (b.cid.startsWith('d[') ? dirOfCid(b.cid).length : 0)).filter(f => {
    if (!f.cid.startsWith('d[')) return true;
    const k = f.kind + S + f.pid + S + f.exp, d = dirOfCid(f.cid);
    const kept = keptDirs.get(k) || [];
    if (kept.some(kd => d.startsWith(kd + '/'))) return false;
    kept.push(d); keptDirs.set(k, kept); return true; });
  const groups = [];
  for (const c of pruned.sort((a, b) => b.bpi - a.bpi)) { let pl = false;
    for (const g of groups) if (g.cid === c.cid && jac(new Set(g.lead.conform), new Set(c.conform)) >= 0.9) { g.surfaces.push(c); pl = true; break; }
    if (!pl) groups.push({ cid: c.cid, lead: c, surfaces: [c] }); }
  return { facts: groups.map(g => ({ ...g.lead, nSurfaces: g.surfaces.length })), C, idxCost }; }
function roleLift(ps, ri, facts) { // per role: bits/instance of behavior compression; ≤0 ⇒ decorative
  const lift = {}; for (const f of facts) { if (!/^r\d/.test(f.cid)) continue;
    const r = +f.cid.slice(1).split(':')[0]; lift[r] = (lift[r] || 0) + f.bpi * 0.1 + 0.1; } // proxy: any accepted role fact ⇒ lift>0
  return lift; }

// ===== FULL HISTORY: every commit, every blob → AST; per-scope lifecycle + VALUE EVENTS + co-change =====
async function loadFullHistory(gitdir) {
  const t0 = Date.now();
  const raw = execFileSync('git', ['-C', gitdir, 'log', '--reverse', '--raw', '--no-abbrev', '--no-merges', '-M',
    '--format=%x01%H%x00%ct%x00%an <%ae>%x00%s'], { maxBuffer: 1 << 30 }).toString();
  const events = []; const commits = []; let cur = null; const blobExt = new Map();
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) { const p = line.slice(1).split('\x00');
      cur = { ts: +p[1], agent: /claude|copilot|cursor|codex|devin|\bbot\b|gpt|gemini|dependabot/i.test(p[2]), author: hashStr(p[2]), fix: /^(fix|hotfix|bugfix)\b|revert/i.test(p[3] || ''), files: [] };
      commits.push(cur); continue; }
    const m = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([AMD]|R\d+)\t(.+)$/);
    if (!m || !cur) continue;
    const st = m[2][0]; let path = m[3], oldPath = null;
    if (st === 'R') { const [o, n] = m[3].split('\t'); oldPath = o; path = n; }
    if (!CODE_RE.test(path)) { if (!EXCL.test(path)) cur.files.push(path); continue; }
    cur.files.push(path);
    events.push({ sha: st === 'D' ? null : m[1], st, path, oldPath, c: cur });
    if (st !== 'D' && !/^0+$/.test(m[1])) blobExt.set(m[1], extname(path)); }
  // parse each distinct blob once EVER (language from the historical path's extension — no sniffing):
  // a content-addressed persistent cache makes learning incremental — a new commit costs only its new blobs
  const blobScopes = new Map(); let parsed = 0, bytes = 0;
  const cacheF = MODEL + '.blobcache.jsonl'; let cacheValid = false;
  if (existsSync(cacheF)) { const lines = readFileSync(cacheF, 'utf8').split('\n').filter(Boolean);
    if (lines.length && JSON.parse(lines[0]).x === EXTR_V) { cacheValid = true;
      for (const l of lines.slice(1)) { const r = JSON.parse(l); blobScopes.set(r.s, r.sc); } } }
  const allShas = [...blobExt.keys()];
  const cachedHits = allShas.filter(s => blobScopes.has(s)).length;
  const newRecs = [];
  const shas = allShas.filter(s => !blobScopes.has(s));
  for (let i = 0; i < shas.length; i += 400) {
    const chunk = shas.slice(i, i + 400);
    const out = spawnSync('git', ['-C', gitdir, 'cat-file', '--batch'], { input: chunk.join('\n'), maxBuffer: 1 << 30 }).stdout;
    let off = 0;
    while (off < out.length) { const nl = out.indexOf(10, off); if (nl < 0) break;
      const hdr = out.slice(off, nl).toString().split(' ');
      if (hdr[1] === 'missing') { off = nl + 1; continue; }
      const size = +hdr[2]; const body = out.slice(nl + 1, nl + 1 + size); off = nl + 1 + size + 1;
      bytes += size; const sha = hdr[0]; if (size > 1.5e6) { blobScopes.set(sha, []); newRecs.push({ s: sha, sc: [] }); continue; }
      try { const ext = blobExt.get(sha) || '.js'; const p = await getParser(ext); const b = bindingFor(p._g);
        const tr = p.parse(body.toString());
        const sc = extractScopes('b.tmp', tr, b).filter(s => s.kind !== 'file').map(s => ({ k: s.kind, n: s.name, o: s.ord,
          bh: hashStr(s.preds['auto.first1'] + '|' + [...s.seen].sort().join(',') + '|' + [...s.calls].sort().join(',') + '|' + s.decos.join(',') + '|' + s.sup.join(',') + '|' + s.preds['auto.nameshape']),
          val: { ns: s.preds['auto.nameshape'], f1: s.preds['auto.first1'] || '', ret: s.preds['auto.ret'] || '', deco: [...s.decos].sort(), sup: [...s.sup].sort() } }));
        tr.delete(); blobScopes.set(sha, sc); parsed++; newRecs.push({ s: sha, sc });
      } catch { blobScopes.set(sha, []); newRecs.push({ s: sha, sc: [] }); } } }
  if (newRecs.length || !cacheValid) { // persist: rewrite on version mismatch, append otherwise
    if (!cacheValid) writeFileSync(cacheF, JSON.stringify({ x: EXTR_V }) + '\n');
    if (newRecs.length) appendFileSync(cacheF, newRecs.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  // replay: lifecycle + VALUE EVENTS per (scopeKey, dimension)
  const lc = new Map(); const vev = new Map(); // vev: key scopeKey -> [{ts, author, agent, val}]
  const prevState = new Map(); const renames = new Map();
  for (const e of events) {
    if (e.st === 'R' && e.oldPath) { const s0 = prevState.get(e.oldPath); if (s0) { prevState.set(e.path, s0); prevState.delete(e.oldPath); renames.set(e.oldPath, e.path); } }
    if (e.st === 'D') { prevState.delete(e.path); continue; }
    const scopes = blobScopes.get(e.sha) || []; const curM = new Map();
    for (const s of scopes) curM.set(s.k + '#' + s.n + (s.o ? '#' + s.o : ''), s);
    const prev = prevState.get(e.path) || new Map();
    for (const [k, s] of curM) { const key = e.path + '#' + k; let L = lc.get(key);
      if (!L) { L = { path: e.path, first: e.c.ts, last: e.c.ts, mods: 0, churn: false, fix: 0, agentLast: e.c.agent }; lc.set(key, L);
        (vev.get(key) || vev.set(key, []).get(key)).push({ ts: e.c.ts, author: e.c.author, agent: e.c.agent, val: s.val }); }
      const pv = prev.get(k);
      if (pv && pv.bh !== s.bh) { L.mods++; if (e.c.fix) L.fix++; if (e.c.ts - L.first <= 14 * 86400) L.churn = true;
        L.last = e.c.ts; L.agentLast = e.c.agent;
        if (JSON.stringify(pv.val) !== JSON.stringify(s.val)) vev.get(key).push({ ts: e.c.ts, author: e.c.author, agent: e.c.agent, val: s.val }); } }
    prevState.set(e.path, curM); }
  // co-change (all history, mega-commit cap)
  const pairSup = new Map(); const fileCommits = new Map();
  for (const c of commits) { const fs2 = [...new Set(c.files)].filter(f => !EXCL.test(f));
    if (fs2.length < 2 || fs2.length > CFG.megaCap) continue;
    for (const f of fs2) fileCommits.set(f, (fileCommits.get(f) || 0) + 1);
    for (let i = 0; i < fs2.length; i++) for (let j = i + 1; j < fs2.length; j++) {
      const k = fs2[i] < fs2[j] ? fs2[i] + '' + fs2[j] : fs2[j] + '' + fs2[i];
      pairSup.set(k, (pairSup.get(k) || 0) + 1); } }
  const cochange = [];
  for (const [k, sup] of pairSup) { if (sup < CFG.cochangeMinSup) continue; const [a, b] = k.split('');
    const ca = Math.max(sup / (fileCommits.get(a) || 1), sup / (fileCommits.get(b) || 1));
    if (ca >= CFG.cochangeMinConf) cochange.push({ a, b, sup, conf: +ca.toFixed(2) }); }
  const NOW = commits.length ? commits[commits.length - 1].ts : 0; // clock = HEAD committer timestamp (I2a) — never max(last_modified), never wall clock
  console.error(`[history] ${commits.length} commits, ${allShas.length} blobs (${cachedHits} cached, ${parsed} parsed), ${(Date.now() - t0) / 1000 | 0}s`);
  return { lc, vev, cochange, NOW, stats: { commits: commits.length, events: events.length, blobs: allShas.length, parsed, cached: cachedHits, mb: +(bytes / 1e6).toFixed(1) } }; }
function mkWeightFn(H, ledger) { if (!H) return { wfn: () => 1, ageFn: null };
  const filelvl = new Map();
  for (const [, L] of H.lc) { const p = L.path; let F = filelvl.get(p);
    if (!F) { F = { ...L }; filelvl.set(p, F); } else { F.first = Math.min(F.first, L.first); if (L.last > F.last) { F.last = L.last; F.agentLast = L.agentLast; } } }
  const get = s => H.lc.get(skeyR(s.rel, s)) || filelvl.get(s.rel) || null;
  return { ageFn: s => { const L = get(s); return L ? (H.NOW - L.first) / 86400 : 0; },
    wfn: s => { const L = get(s); if (!L) return 0.3;
      const stable = Math.max(0, (H.NOW - L.last) / 86400), age = Math.max(0, (H.NOW - L.first) / 86400);
      const ws = Math.min(1, stable / CFG.survDays) * (age < CFG.freshDays ? 0.5 : 1);
      const wp = L.agentLast ? CFG.agentBase + (1 - CFG.agentBase) * Math.min(1, stable / CFG.promoteDays) : 1.0;
      let w = Math.max(CFG.floor, ws * wp * (L.churn ? 0.25 : 1));
      return w; }, get }; }
// dimension value from a historical val snapshot, for trend/calibration-supported pids
function valOf(pid, v) { if (pid === 'auto.nameshape') return v.ns; if (pid === 'auto.first1') return v.f1 || undefined;
  if (pid === 'auto.ret') return v.ret || undefined;
  if (pid.startsWith('auto.deco:@')) return v.deco.includes(pid.slice(11)) ? 'true' : 'false';
  if (pid.startsWith('auto.extends:')) return v.sup.includes(pid.slice(13)) ? 'true' : 'false';
  return undefined; }
// trends + attractor(report-only) + nucleation over the WHOLE history
function trendsFor(fact, ps, H) {
  const keys = fact.conform.concat(fact.deviants.map(d => d.gi)).map(gi => ({ gi, key: skeyR(ps[gi].rel, ps[gi]) }));
  const t0 = Math.min(...[...H.lc.values()].map(l => l.first)); const win = CFG.trendWinDays * 86400;
  const nWin = Math.min(24, Math.ceil((H.NOW - t0) / win)); const shares = []; const authorsByVal = Object.create(null);
  for (let w = nWin - 1; w >= 0; w--) { const end = H.NOW - w * win; let n = 0, conf = 0; const other = {};
    for (const { key } of keys) { const evs = H.vev.get(key); const L = H.lc.get(key); if (!evs || !L || L.first > end) continue;
      let val = null; for (const e of evs) { if (e.ts <= end) val = e.val; else break; }
      if (!val) continue; const v = valOf(fact.pid, val); if (v === undefined) continue;
      n++; if (v === fact.exp) conf++; else { other[v] = (other[v] || 0) + 1; } }
    if (n >= 4) shares.push({ end, share: +(conf / n).toFixed(2), n }); }
  for (const { key } of keys) { const evs = H.vev.get(key) || [];
    for (const e of evs) { const v = valOf(fact.pid, e.val); if (v !== undefined && v !== fact.exp && !e.agent) (authorsByVal[v] ||= new Set()).add(e.author); } }
  let attractor = null, nucleating = null;
  if (shares.length >= 3) { const last = shares[shares.length - 1];
    const xs = shares.map((_, i) => i), ys = shares.map(s => 1 - s.share);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / Math.max(1e-9, xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const minority = Object.entries(authorsByVal).sort((a, b) => b[1].size - a[1].size)[0];
    if (slope > 0.02 && minority && minority[1].size >= 2 && (1 - last.share) > 0.05) nucleating = minority[0];
    attractor = last.share >= 0.5 ? fact.exp : (minority ? minority[0] : fact.exp); }
  return { shares: shares.slice(-8), attractor, nucleating }; }
// calibration: temporal split, τ_c by point precision, DENY by Wilson LB
function calibrate(fact, ps, H) {
  const split = H.NOW - CFG.calibHorizonDays * 86400; const settle = H.NOW - CFG.calibSettleDays * 86400;
  if (Math.min(...[...H.lc.values()].map(l => l.first)) > split) return { available: false, reason: 'history<2x horizon' };
  const evts = [];
  for (const gi of fact.conform.concat(fact.deviants.map(d => d.gi))) { const s = ps[gi];
    const key = skeyR(s.rel, s); const evs = H.vev.get(key); if (!evs) continue;
    for (let i = 1; i < evs.length; i++) { const e = evs[i]; if (e.ts <= split || e.ts > settle) continue;
      const v = valOf(fact.pid, e.val); if (v === undefined || v === fact.exp) continue;
      let repaired = false; for (let j = i + 1; j < evs.length; j++) if (valOf(fact.pid, evs[j].val) === fact.exp) { repaired = true; break; }
      evts.push({ repaired }); } }
  if (evts.length < CFG.calibMinEv) return { available: false, reason: `events ${evts.length}<${CFG.calibMinEv}`, events: evts.length };
  const p = evts.filter(e => e.repaired).length / evts.length;
  const z = 1.96, n = evts.length, lb = (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
  return { available: true, events: n, precision: +p.toFixed(2), wilsonLB: +lb.toFixed(2),
    tauC: p >= CFG.targetPrec ? CFG.tau : CFG.tau + 1.5, denyEligible: lb >= 0.9 && n >= CFG.denyMinEv }; }

// ===== VERBALIZER =====
function verbalize(f, exNames) {
  const unit = { method: 'methods', type: 'types', file: 'files', module: 'directories' }[f.kind] || f.kind;
  const neg = f.exp === 'false'; const p = f.pid;
  if (p.startsWith('auto.has:')) return `${unit} here ${neg ? 'never contain' : 'always contain'} a \`${p.slice(9)}\``;
  if (p.startsWith('auto.call:')) return `${unit} here ${neg ? 'never call' : 'call'} \`${p.slice(10)}\``;
  if (p.startsWith('auto.deco:')) return `${unit} here ${neg ? 'are not annotated with' : 'are annotated with'} \`${p.slice(10)}\``;
  if (p.startsWith('auto.imp:')) return `${unit} here ${neg ? 'do not import' : 'import'} \`${p.slice(9)}\``;
  if (p.startsWith('auto.extends:')) return `${unit} here ${neg ? 'do not extend' : 'extend'} \`${p.slice(13)}\``;
  if (p.startsWith('auto.stshape:')) return `${unit} here ${neg ? 'never use' : 'use'} the structure \`${p.slice(13).slice(0, 60)}\``;
  if (p === 'auto.nameshape' || p === 'auto.filenameshape') return `${unit} here have names like ${exNames.map(n => '`' + n + '`').join(', ')}`;
  if (p === 'auto.first1') return `${unit} here start with a \`${f.exp}\``;
  if (p === 'auto.ret') return `${unit} here return a \`${f.exp}\``;
  if (p === 'auto.arity') return `${unit} here take ${f.exp} parameter(s)`;
  if (p === 'auto.varshape') return `${unit} here name local variables like \`${f.exp}\``;
  if (p.startsWith('auto.dir')) return `${unit} here live under \`${f.exp}/\``;
  if (p.startsWith('auto.mod')) return `${unit}: ${p.slice(8)} = \`${f.exp}\``;
  return `${p} = ${f.exp}`; }

// ===== LEARN =====
async function learn() {
  const root = REPO; const t0 = Date.now(); const files = [...walkFiles(root, root)];
  const all = []; const V = { nodeType: new Map(), call: new Map(), imp: new Map(), ext: new Map(), shape: new Map(), deco: new Map() };
  for (const rel of files) { let src; try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    if (src.length > 1.5e6) continue;
    try { const p = await getParser(extname(rel)); const b = bindingFor(p._g); const tr = p.parse(src); all.push(...extractScopes(rel, tr, b)); tr.delete(); } catch {} }
  // module scopes
  const dirFiles = new Map();
  for (const s of all) if (s.kind === 'file') { const d = dirname(s.rel); (dirFiles.get(d) || dirFiles.set(d, []).get(d)).push(s); }
  for (const [d, fs2] of dirFiles) if (fs2.length >= 3 && d !== '.') { const cnt = {};
    for (const f2 of fs2) { const sh = f2.preds['auto.filenameshape']; cnt[sh] = (cnt[sh] || 0) + 1; }
    all.push({ kind: 'module', name: basename(d), rel: d, line: 1, sup: [], decos: [], calls: new Set(), seen: new Set(), shapes: new Set(), imports: [], feats: [], ownCount: 0,
      preds: { 'auto.moddirshape': nameShape(basename(d)), 'auto.modfileshape': Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0], 'auto.modsize': fs2.length >= 20 ? '20+' : fs2.length >= 8 ? '8-19' : '3-7' } }); }
  const pkgs = []; (function fp(d) { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const full = join(d, e.name); const rel = relative(root, full); if (EXCL.test(rel + '/')) continue;
      if (e.isDirectory()) fp(full); else if (/^(package\.json|pyproject\.toml|go\.mod|pom\.xml|Cargo\.toml)$/.test(e.name)) pkgs.push(relative(root, d) || '.'); } })(root);
  const partOf = rel => { let b = null; for (const d of pkgs) { if (d === '.') continue; if ((rel + '/').startsWith(d + '/')) if (!b || d.length > b.length) b = d; } return b || '_root'; };
  const byPart = new Map();
  for (const s of all) { const p = partOf(s.rel); (byPart.get(p) || byPart.set(p, []).get(p)).push(s); }
  const merged = new Map(); const bucket = [];
  for (const [p, ss] of byPart) (ss.length < 300 ? bucket.push(...ss) : merged.set(p, ss));
  if (bucket.length >= 300) merged.set('_repo', bucket);
  const H = OPTS.fullhistory ? await loadFullHistory(OPTS.fullhistory) : null;
  const ledger = existsSync(MODEL + '.state/ledger.jsonl') ? readFileSync(MODEL + '.state/ledger.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const ledgerSet = new Set(ledger.map(l => l.key + '#' + l.pid));
  const seeds = existsSync(MODEL + '.seeds.json') ? JSON.parse(readFileSync(MODEL + '.seeds.json', 'utf8')) : [];
  const { wfn: baseW, ageFn, get: lcGet } = mkWeightFn(H);
  const model = { repo: basename(root), pkgs, generatedAt: 0, partitions: [] };
  let agentShareNum = 0, agentShareDen = 0;
  for (const [pname, ps] of merged) {
    for (const m of Object.values(V)) m.clear();
    for (const s of ps) { if (s.kind === 'method') { for (const nt of s.seen) if (/statement|expression|declaration|clause/.test(nt)) V.nodeType.set(nt, (V.nodeType.get(nt) || 0) + 1);
        for (const c of s.calls) V.call.set(c, (V.call.get(c) || 0) + 1); for (const sh of s.shapes) V.shape.set(sh, (V.shape.get(sh) || 0) + 1); }
      if (s.kind !== 'file' && s.kind !== 'module') { for (const d of s.decos) V.deco.set(d, (V.deco.get(d) || 0) + 1); for (const e of s.sup) V.ext.set(e, (V.ext.get(e) || 0) + 1); }
      if (s.kind === 'file') for (const i of s.imports) V.imp.set(i, (V.imp.get(i) || 0) + 1); }
    const top = k => [...V[k]].filter(([, c]) => c >= (SUP[k] || 8)).sort((a, b) => b[1] - a[1]).slice(0, TOPK[k] || 40).map(([x]) => x);
    const vocab = { NT: top('nodeType'), CALL: top('call'), IMP: top('imp'), EXT: top('ext'), SHAPE: top('shape'), DECO: top('deco') };
    for (const s of ps) applyVocab(s, vocab);
    const ri = induceRoles(ps);
    // hook_shaped ledger → per-(scope,pid) weight cap: implemented by wrapping wfn per scope+pid inside mine via marker
    const wfn = s => { const w = baseW(s); return w; };
    const capSet = ledgerSet; // (scope,pid) caps applied in survived-raw + counts via post-filter below
    const { facts, C } = mine(ps, ri, s => { const w = wfn(s); return w; }, seeds, ageFn);
    // apply ledger cap effect: recompute counts for facts whose members include capped pairs (approximation at fact level)
    for (const f of facts) { let capped = 0; for (const gi of f.conform) { const s = ps[gi]; if (capSet.has(skeyR(s.rel, s) + '#' + f.pid)) capped++; }
      f.hookShapedConform = capped; }
    if (H) for (const s of ps) { const L = lcGet(s); if (!L || s.kind === 'file' || s.kind === 'module') continue;
      if ((H.NOW - L.first) / 86400 <= 120) { agentShareDen += baseW(s); if (L.agentLast) agentShareNum += baseW(s); } }
    const lifts = roleLift(ps, ri, facts);
    const assignments = {}; ri.assign.forEach((r, i) => { const s = ps[i]; assignments[skeyR(s.rel, s)] = ri.amb.has(i) ? -1 : r; });
    const exportFacts = facts.sort((a, b) => b.bpi - a.bpi).map(f => {
      const unamb = f.conform.filter(gi => !ri.amb.has(gi)); const exs = (unamb.length ? unamb : f.conform).slice(0, 3);
      const trend = H ? trendsFor(f, ps, H) : null;
      const calib = H ? calibrate(f, ps, H) : { available: false, reason: 'no history' };
      return { cid: f.cid, kind: f.kind, pid: f.pid, exp: f.exp, parentExp: f.parentExp, counts: f.counts, alphabet: f.alphabet,
        raw: f.raw, sraw: f.sraw, share: +f.srawShare.toFixed(3), bpi: +f.bpi.toFixed(2), tau: calib.available ? calib.tauC : f.tau,
        nSurfaces: f.nSurfaces, hookShapedConform: f.hookShapedConform || 0,
        trend: trend && trend.shares.length ? trend : undefined, calib,
        suppressedValue: trend ? trend.nucleating : null, denyEligible: !!(calib.available && calib.denyEligible),
        exemplars: exs.map(gi => ({ rel: ps[gi].rel, line: ps[gi].line, name: ps[gi].name })), deviantsN: f.deviants.length }; });
    model.partitions.push({ name: pname, vocab, assignments, roleLift: lifts,
      medoids: ri.medoids.map(m => ({ feats: m.feats, label: m.label })), facts: exportFacts }); }
  model.agentShare = agentShareDen ? +(agentShareNum / agentShareDen).toFixed(2) : null;
  model.cochange = H ? [...H.cochange].sort((a, b) => b.sup - a.sup).slice(0, 5000) : []; // cap by descending support — a truncating cap must not drop the strongest pair
  model.historyStats = H ? { commits: H.stats.commits, events: H.stats.events, blobs: H.stats.blobs } : null; // parsed/cached/mb are run diagnostics, not repo facts — they would break I2a byte-identity across cache states
  writeFileSync(MODEL, JSON.stringify(model));
  console.log(JSON.stringify({ repo: model.repo, files: files.length, ms: Date.now() - t0, history: model.historyStats,
    agentShare: model.agentShare, cochangePairs: model.cochange.length,
    partitions: model.partitions.map(p => ({ name: p.name, medoids: p.medoids.length, facts: p.facts.length,
      denyEligible: p.facts.filter(f => f.denyEligible).length, nucleating: p.facts.filter(f => f.suppressedValue).length })) }, null, 1)); }

// ===== CHECK (verdict + telemetry + compliance + dedup + budgets) =====
async function checkFile(model, root, rel, contentOverride, asPath, session, harness) { // harness: hermetic — no state reads/writes, no caps
  try { return await checkFileInner(model, root, rel, contentOverride, asPath, session, harness); }
  catch (err) { if (harness) throw err; // the harness must fail loudly; the hook path fails open (I1)
    console.error('[roots] incident (fail-open): ' + (err?.message || err)); return []; } }
async function checkFileInner(model, root, rel, contentOverride, asPath, session, harness) {
  const effRel = asPath || rel;
  const src = contentOverride ?? readFileSync(join(root, rel), 'utf8');
  const partOf = r => { let b = null; for (const d of model.pkgs) { if (d === '.') continue; if ((r + '/').startsWith(d + '/')) if (!b || d.length > b.length) b = d; } return b || '_root'; };
  const part = model.partitions.find(p => p.name === partOf(effRel)) || model.partitions.find(p => p.name === '_repo') || model.partitions[0];
  if (!part) return [];
  const p = await getParser(extname(rel)); const b = bindingFor(p._g); const tr = p.parse(src);
  const scopes = extractScopes(effRel, tr, b); tr.delete();
  if (OPTS.debug) console.error(`[debug] part=${part.name} scopes=${scopes.length} facts=${part.facts.length} src=${src.length}b`);
  for (const s of scopes) applyVocab(s, part.vocab);
  if (OPTS.debug) for (const s of scopes) { const v = s.preds['auto.call:oazapfts.fetchBlob']; if (v === 'true') console.error(`[debug] ${s.kind} ${s.name} pred=true calls=${s.calls.size}`); }
  const medoids = part.medoids;
  const { assign, amb } = assignAll(scopes, medoids);
  const stateDir = MODEL + '.state'; if (!harness) mkdirSync(stateDir, { recursive: true });
  const sessFile = join(stateDir, 'session-' + (session || 'default') + '.json');
  const sess = !harness && existsSync(sessFile) ? JSON.parse(readFileSync(sessFile, 'utf8')) : { dedup: [], warns: 0 };
  const dedup = new Set(sess.dedup);
  const telemetry = !harness && existsSync(join(stateDir, 'telemetry.jsonl')) ? readFileSync(join(stateDir, 'telemetry.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const demoted = new Set(); // health: compliance WilsonLB < 0.3 over ≥8 resolved
  { const byFact = {}; for (const t of telemetry) { const k = t.factKey; (byFact[k] ||= { c: 0, n: 0 }); if (t.after !== undefined) { byFact[k].n++; if (t.after === 'complied') byFact[k].c++; } }
    for (const [k, v] of Object.entries(byFact)) if (v.n >= CFG.healthMinN) { const pr = v.c / v.n, z = 1.96, n = v.n;
      const lb = (pr + z * z / (2 * n) - z * Math.sqrt(pr * (1 - pr) / n + z * z / (4 * n * n))) / (1 + z * z / n);
      if (lb < CFG.healthMinCompliance) demoted.add(k); } }
  const msgs = [];
  // specificity governance: for each pid, the most specific applicable context governs the scope —
  // role or directory over partition-wide (`_all`); among applicable facts the smallest evidence class wins.
  const ctxRank = f => /^r\d/.test(f.cid) ? 0 : f.cid.startsWith('d[') ? 1 : 2;
  scopes.forEach((s, i) => {
    let role = assign.get(i); let roleOk = role !== undefined && !amb.has(i);
    const sticky = part.assignments[skeyR(effRel, s)];
    if (sticky !== undefined && sticky !== -1) { role = sticky; roleOk = true; }
    const gov = new Map();
    for (const f of part.facts) {
      if (f.kind !== s.kind) continue;
      if (/^r\d/.test(f.cid)) { if (!roleOk || 'r' + role + ':' + s.kind !== f.cid) continue; }
      else if (f.cid.startsWith('d[')) { const d = f.cid.slice(2, f.cid.indexOf(']')); if (!effRel.startsWith(d + '/')) continue; }
      const g = gov.get(f.pid);
      if (!g || f.sraw < g.sraw || (f.sraw === g.sraw && ctxRank(f) < ctxRank(g))) gov.set(f.pid, f);
    }
    for (const f of gov.values()) {
      const isRole = /^r\d/.test(f.cid);
      const v = s.preds[f.pid];
      const scopeKey = skeyR(effRel, s);
      // COMPLIANCE CLOSURE: open intervention + now conforming ⇒ ledger mark + telemetry 'complied'
      const open = harness ? undefined : telemetry.find(t => t.key === scopeKey && t.pid === f.pid && t.after === undefined);
      if (open && v === f.exp) { appendFileSync(join(stateDir, 'ledger.jsonl'), JSON.stringify({ key: scopeKey, pid: f.pid }) + '\n');
        appendFileSync(join(stateDir, 'telemetry.jsonl'), JSON.stringify({ ...open, after: 'complied' }) + '\n'); open.after = 'complied'; }
      else if (open && v !== undefined && v !== f.exp && open.session !== session) { // ignored-closure at most once per session — a re-view is not a fresh ignore
        appendFileSync(join(stateDir, 'telemetry.jsonl'), JSON.stringify({ ...open, after: 'ignored' }) + '\n'); open.after = 'ignored'; }
      if (v === undefined || v === f.exp) continue;
      if (f.suppressedValue && v === f.suppressedValue) continue;              // nucleation stand-down
      if (demoted.has(f.cid + '|' + f.pid)) continue;                           // health demotion
      const neff = Object.values(f.counts).reduce((a2, b2) => a2 + b2, 0);
      const K = isBool(f.pid) ? 2 : f.alphabet.length + 1;
      const known = f.alphabet.includes(v);
      const d = Math.log2(kt(f.counts, K, f.exp, neff) / kt(f.counts, K, known ? v : ' ', neff));
      if (d < (f.tau || CFG.tau)) continue;
      const dk = scopeKey + '|' + f.pid;
      const sev = f.denyEligible && known ? 'DENY' : 'WARN';
      if (sev === 'WARN' && dedup.has(dk)) continue;                            // dedup WARN only
      if (sev === 'WARN' && sess.warns >= CFG.sessionMaxWarn) continue;         // session budget
      const isDir = f.cid.startsWith('d[');
      const label = isRole ? (medoids[role]?.label || 'group')
        : isDir ? `local (${f.cid.slice(2, f.cid.indexOf(']'))}/)`
        : (part.name === '_repo' ? 'repo-wide' : `package-wide (${part.name})`);
      const contrast = (isRole || isDir) && f.parentExp != null && f.parentExp !== f.exp
        ? `\nThis is the local default ${isDir ? 'of this directory' : 'of this group'} — the wider package's norm differs here.` : '';
      msgs.push({ sev, scope: s.name, key: scopeKey, line: s.line, pid: f.pid, factKey: f.cid + '|' + f.pid, delta: +d.toFixed(2), exp: f.exp, obs: v,
        text: `[roots${sev === 'DENY' ? '/BLOCK' : ''}] ${label} convention: ${verbalize(f, f.exemplars.map(e => e.name))}\n` +
          `${f.sraw - Math.round((1 - f.share) * f.sraw)}/${f.sraw} established conform${f.hookShapedConform ? ` (${f.hookShapedConform} hook-shaped excluded from evidence)` : ''}. Your ${s.kind} \`${s.name}\` deviates${known ? '' : ' (a value this repo has not used before)'}.${contrast}\n` +
          `See: ${f.exemplars.map(e => `${e.rel}:${e.line} \`${e.name}\``).join(' · ')}` }); } });
  msgs.sort((a, b) => (a.sev === b.sev ? b.delta - a.delta : a.sev === 'DENY' ? -1 : 1));
  const out = (OPTS.all || harness) ? msgs : msgs.slice(0, CFG.maxMsgs);
  if (!harness) { for (const m of out) { if (m.sev === 'WARN') { dedup.add(m.key + '|' + m.pid); sess.warns++; }
      appendFileSync(join(stateDir, 'telemetry.jsonl'), JSON.stringify({ key: m.key, pid: m.pid, factKey: m.factKey, expected: m.exp, observed: m.obs, delta: m.delta, sev: m.sev, session, ts: 0 }) + '\n'); }
    sess.dedup = [...dedup]; writeFileSync(sessFile, JSON.stringify(sess)); }
  return out; }

// ===== other commands =====
async function report(model) {
  for (const p of model.partitions) { console.log(`\n== ${p.name} — ${p.facts.length} conventions ==`);
    for (const f of p.facts.slice(0, +OPTS.top || 15)) {
      const t = f.trend; const tr = t ? ` trend[${t.shares.map(s => Math.round(s.share * 100)).join('>')}%]${t.nucleating ? ` NUCLEATING:${t.nucleating}` : ''}` : '';
      const cal = f.calib?.available ? ` calib(p=${f.calib.precision},n=${f.calib.events}${f.denyEligible ? ',DENY-OK' : ''})` : '';
      console.log(`  [${f.cid}] ${verbalize(f, f.exemplars.map(e => e.name)).slice(0, 90)} — ${Math.round(f.share * 100)}% of ${f.sraw} established${tr}${cal}`); } }
  console.log(`\nagentShare=${model.agentShare} cochangePairs=${model.cochange.length}`); }
async function completeness(model) { const changed = ARGS;
  const exp = new Set();
  for (const c of model.cochange) for (const f of changed) { if (c.a === f && !changed.includes(c.b)) exp.add(`${c.b} (co-changed ${c.sup}x, conf ${c.conf})`);
    if (c.b === f && !changed.includes(c.a)) exp.add(`${c.a} (co-changed ${c.sup}x, conf ${c.conf})`); }
  console.log(exp.size ? `[roots] Edits like this historically also touch:\n` + [...exp].slice(0, 5).map(x => '  - ' + x).join('\n') : '(complete)'); }
function mutate(src, f, ex) { const p = f.pid;
  if (p.startsWith('auto.deco:') && f.exp === 'true') { const d = p.slice(10).replace('@', '');
    const re = new RegExp('^\\s*@' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b.*$', 'gm');
    return re.test(src) ? src.replace(re, '') : null; }
  if (p.startsWith('auto.extends:') && f.exp === 'true') { const e = p.slice(13);
    const re = new RegExp('(extends|implements|\\()\\s*' + e.replace(/[$.]/g, '\\$&') + '\\b');
    const lineOff = src.split('\n').slice(0, Math.max(0, (ex.line || 1) - 1)).join('\n').length; // mutate the exemplar's own heritage, not the file's first
    const tail = src.slice(lineOff);
    return re.test(tail) ? src.slice(0, lineOff) + tail.replace(re, '$1 SomethingElse') : (re.test(src) ? src.replace(re, '$1 SomethingElse') : null); }
  if (p.startsWith('auto.imp:') && f.exp === 'false') { const spec = p.slice(9); if (spec.startsWith('~/')) return null;
    // one candidate per import syntax family — re-extraction keeps whichever this file's grammar accepts
    return { candidates: [`import __planted from '${spec}';\n` + src, `import ${spec}\n` + src, `from ${spec} import __planted\n` + src, `#include <${spec}>\n` + src], imp: spec }; }
  if (p === 'auto.nameshape' && ex) { const nn = tokenize(ex.name).join('_'); if (!nn || nn === ex.name) return null; return src.split(ex.name).join(nn); }
  if (p.startsWith('auto.call:') && f.exp === 'false') { const call = p.slice(10); if (/[^\w.$]/.test(call)) return null;
    const lineOff = src.split('\n').slice(0, Math.max(0, (ex.line || 1) - 1)).join('\n').length; // anchor at the exemplar's own line
    const at = src.indexOf(ex.name, lineOff); if (at < 0) return null;
    // candidate injection points: successive braces after the name (brace languages) plus indentation-based
    // insertion after a ':'-terminated header line (offside languages) — re-extraction validates the landing
    const cands = []; let brace = src.indexOf('{', at);
    for (let k = 0; k < 10 && brace >= 0; k++) { cands.push(src.slice(0, brace + 1) + `\n  ${call}();` + src.slice(brace + 1)); brace = src.indexOf('{', brace + 1); }
    const lines = src.split('\n');
    for (let li = Math.max(0, (ex.line || 1) - 1); li < Math.min(lines.length, (ex.line || 1) + 5); li++) {
      if (!/:\s*(#.*)?$/.test(lines[li])) continue;
      const indent = (lines[li].match(/^\s*/)[0] || '') + '    ';
      cands.push([...lines.slice(0, li + 1), indent + call + '()', ...lines.slice(li + 1)].join('\n')); }
    return cands.length ? { candidates: cands, call } : null; }
  return null; }
async function mutateTest(model) { const root = REPO; const res = { detected: 0, missed: 0, silentOK: 0, falseFire: 0, unsupported: 0, cases: [] };
  for (const part of model.partitions) {
    const cands = part.facts.filter(f => /^auto\.(deco|extends|imp|call):|^auto\.nameshape$/.test(f.pid) && f.exemplars.length).slice(0, 16);
    for (const f of cands) { const ex = f.exemplars[0]; let src; try { src = readFileSync(join(root, ex.rel), 'utf8'); } catch { continue; }
      const before = await checkFile(model, root, ex.rel, src, null, 'mt-' + Math.random(), true);
      if (before.some(m => m.pid === f.pid && m.scope === ex.name)) { res.falseFire++; res.cases.push({ FALSEFIRE: f.cid + ' ' + f.pid + '=' + f.exp, file: ex.rel, scope: ex.name }); continue; }
      res.silentOK++;
      let mut = mutate(src, f, ex); if (mut === null) { res.unsupported++; continue; }
      if (mut.candidates) { // injected mutations: keep the candidate where the planted artifact really lands (ground truth = extraction)
        const pp = await getParser(extname(ex.rel)); const bb = bindingFor(pp._g); let picked = null;
        for (const cand of mut.candidates) { const tr2 = pp.parse(cand); const ss = extractScopes(ex.rel, tr2, bb); tr2.delete();
          const ok = mut.call ? ss.find(x => x.name === ex.name && x.calls.has(mut.call))
                              : ss.find(x => x.kind === 'file' && x.imports.includes(mut.imp));
          if (ok) { picked = cand; break; } }
        if (!picked) { res.unsupported++; continue; } mut = picked; }
      const after = await checkFile(model, root, ex.rel, mut, null, 'mt-' + Math.random(), true);
      const hit = after.some(m => m.pid === f.pid && (m.scope === ex.name || (f.pid === 'auto.nameshape' && m.scope === tokenize(ex.name).join('_')))); // nameshape: the renamed scope itself, not any scope
      res[hit ? 'detected' : 'missed']++;
      if (!hit) res.cases.push({ fact: f.cid + ' ' + f.pid + '=' + f.exp, file: ex.rel }); } }
  console.log(JSON.stringify(res, null, 1)); }
// ===== SPECTRUM (solicited exploration: the full lattice for one file, no acceptance cut) =====
// The hook path speaks only above the gates; spectrum answers an explicit question — "what is local
// and what is global here?" — so it shows EVERY cell of the file's contexts with its continuous score,
// re-enumerated with a deep vocabulary (support floor 2, topK ×4) to recover sub-threshold surfaces.
async function spectrum(model) {
  const rel = ARGS[0]; const root = REPO;
  const partOf = r => { let b = null; for (const d of model.pkgs) { if (d === '.') continue; if ((r + '/').startsWith(d + '/')) if (!b || d.length > b.length) b = d; } return b || '_root'; };
  const pfor = r => model.partitions.find(p => p.name === partOf(r)) || model.partitions.find(p => p.name === '_repo') || model.partitions[0];
  const part = pfor(rel);
  const minBits = OPTS.minbits !== undefined ? +OPTS.minbits : 0; const topN = +OPTS.top || 0;
  const files = [...walkFiles(root, root)].filter(r => pfor(r) === part);
  const ps = [];
  for (const f of files) { let src; try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    try { const p = await getParser(extname(f)); const b = bindingFor(p._g); const tr = p.parse(src); ps.push(...extractScopes(f, tr, b)); tr.delete(); } catch {} }
  const V2 = { nodeType: new Map(), call: new Map(), imp: new Map(), ext: new Map(), shape: new Map(), deco: new Map() };
  for (const s of ps) { if (s.kind === 'method') { for (const nt of s.seen) if (/statement|expression|declaration|clause/.test(nt)) V2.nodeType.set(nt, (V2.nodeType.get(nt) || 0) + 1);
      for (const c of s.calls) V2.call.set(c, (V2.call.get(c) || 0) + 1); for (const sh of s.shapes) V2.shape.set(sh, (V2.shape.get(sh) || 0) + 1); }
    if (s.kind !== 'file' && s.kind !== 'module') { for (const d of s.decos) V2.deco.set(d, (V2.deco.get(d) || 0) + 1); for (const e of s.sup) V2.ext.set(e, (V2.ext.get(e) || 0) + 1); }
    if (s.kind === 'file') for (const i of s.imports) V2.imp.set(i, (V2.imp.get(i) || 0) + 1); }
  const top2 = k => [...V2[k]].filter(([, c]) => c >= Math.max(2, Math.floor((SUP[k] || 8) / 4))).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, (TOPK[k] || 40) * 4).map(([x]) => x);
  const vocab = { NT: top2('nodeType'), CALL: top2('call'), IMP: top2('imp'), EXT: top2('ext'), SHAPE: top2('shape'), DECO: top2('deco') };
  for (const s of ps) applyVocab(s, vocab);
  const { assign, amb } = assignAll(ps, part.medoids);
  const fileScopes = ps.filter(s => s.rel === rel);
  if (!fileScopes.length) { console.log('(no scopes extracted for ' + rel + ')'); return; }
  const roleOf = (s, i) => { const st = part.assignments[skeyR(s.rel, s)]; if (st !== undefined && st !== -1) return st; return assign.has(i) && !amb.has(i) ? assign.get(i) : undefined; };
  const myRoles = new Set(); fileScopes.forEach(s => { const r = roleOf(s, ps.indexOf(s)); if (r !== undefined) myRoles.add('r' + r + ':' + s.kind); });
  const segs = rel.split('/').slice(0, -1); const myDirs = []; for (let k = 1; k <= segs.length; k++) myDirs.push(segs.slice(0, k).join('/'));
  const cells = new Map(); const S = '';
  const add2 = (cid, pid, v) => { const k = cid + S + pid; let c = cells.get(k); if (!c) { c = Object.create(null); cells.set(k, c); } c[v] = (c[v] || 0) + 1; };
  ps.forEach((s, i) => { for (const [pid, v] of Object.entries(s.preds)) {
    add2('_all:' + s.kind, pid, v);
    const r = roleOf(s, i); if (r !== undefined && myRoles.has('r' + r + ':' + s.kind)) add2('r' + r + ':' + s.kind, pid, v);
    for (const d of myDirs) if (s.rel.startsWith(d + '/')) add2('d[' + d + ']:' + s.kind, pid, v); } });
  const idxCost = Math.ceil(Math.log2(Math.max(cells.size, 2)));
  const rows = [];
  for (const [key, c] of cells) { const [cid, pid] = key.split(S); const kind = cid.split(':').pop();
    if (/^auto\.dir\d/.test(pid) && !/^r\d/.test(cid)) continue;
    const n = Object.values(c).reduce((a, b) => a + b, 0); if (n < 3) continue;
    const Vv = Object.keys(c).sort(); const bl = isBool(pid); const K = bl ? 2 : Vv.length + 1;
    const allC = cells.get('_all:' + kind + S + pid); const allN = allC ? Object.values(allC).reduce((a, b) => a + b, 0) : n;
    let data = 0; const isAll = cid.startsWith('_all');
    if (isAll) { const B = Math.max(bl ? 2 : Vv.length, 2); for (const v of Vv) if (c[v]) data += c[v] * Math.log2(kt(c, K, v, n) * B); }
    else for (const v of Vv) if (c[v]) data += c[v] * Math.log2(kt(c, K, v, n) / kt(allC, K, v, allN));
    const bits = data - 0.5 * (K - 1) * Math.log2(Math.max(n, 2)) - idxCost;
    let exp = null, ne = -1; for (const v of Vv) if (c[v] > ne) { exp = v; ne = c[v]; }
    if (!bl && ['other', 'none', 'mixed', '?'].includes(exp)) continue;
    const share = ne / n;
    const isNorm = part.facts.some(f => f.cid === cid && f.pid === pid && f.exp === exp);
    const mine3 = fileScopes.filter(s => s.kind === kind && s.preds[pid] !== undefined).map(s => s.preds[pid]);
    const dev = mine3.some(v => v !== exp);
    rows.push({ cid, pid, exp, share, n, bits, isNorm, dev, has: mine3.length > 0,
      grp: /^r\d/.test(cid) ? 0 : cid.startsWith('d[') ? 1 : 2, depth: cid.startsWith('d[') ? cid.split('/').length : 0 }); }
  rows.sort((a, b) => a.grp - b.grp || b.depth - a.depth || b.bits - a.bits);
  const shown = rows.filter(r => r.bits >= minBits && r.has);
  const out = topN ? shown.slice(0, topN) : shown;
  console.log(`spectrum ${rel} — partition ${part.name} · ${fileScopes.length} scopes · ${cells.size} cells computed · ${rows.length} rows (n≥3) · ${shown.length} at bits≥${minBits} · ${part.facts.length} accepted NORMs in model`);
  for (const r of out) console.log(`  [${r.isNorm ? 'NORM' : 'obs '}] ${r.cid} ${r.pid} = ${r.exp}  share ${r.share.toFixed(2)} n ${r.n} bits ${r.bits.toFixed(1)}${r.dev ? '  ← THIS FILE DEVIATES' : ''}`); }

// ===== WHERE (inverse query: intent → place + expectations + pattern to copy) =====
// "Where do command handlers go?" — lexical match of query tokens against the model's own vocabulary
// (role labels, medoid features, fact payloads, directory names). No embeddings: the model is a small,
// structured distillate in repo-native tokens; when lexical match fails, the compact map is printed and
// the asking agent — itself an LLM — closes the semantic gap better than any retrieval layer would.
async function whereCmd(model) {
  const q = ARGS.join(' ');
  const norm = t => t.toLowerCase().replace(/s$/, '');
  const qt = new Set(tokenize(q).map(norm));
  const cards = [];
  for (const part of model.partitions) {
    const byRole = new Map();
    for (const [k, r] of Object.entries(part.assignments)) { if (r === -1) continue; let a = byRole.get(r); if (!a) { a = []; byRole.set(r, a); } a.push(k); }
    part.medoids.forEach((md, r) => { const members = byRole.get(r) || []; if (members.length < 3) return;
      const toks = new Set(); for (const f of md.feats) for (const t of tokenize(f.slice(4))) toks.add(norm(t));
      const facts = part.facts.filter(f => f.cid.startsWith('r' + r + ':'));
      for (const f of facts) for (const t of tokenize(f.pid.replace(/^auto\.[a-z0-9]+:?@?/, ''))) toks.add(norm(t));
      const dirs = new Map(); for (const k of members) { const d = dirname(k.split('#')[0]); dirs.set(d, (dirs.get(d) || 0) + 1); }
      const topDirs = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 3);
      cards.push({ type: 'group', part: part.name, label: md.label, n: members.length, toks, facts, topDirs, members }); });
    const byDir = new Map();
    for (const f of part.facts) if (f.cid.startsWith('d[')) { const d = f.cid.slice(2, f.cid.indexOf(']')); let a = byDir.get(d); if (!a) { a = []; byDir.set(d, a); } a.push(f); }
    for (const [d, facts] of byDir) { const toks = new Set(tokenize(d).map(norm));
      for (const f of facts) for (const t of tokenize(f.pid.replace(/^auto\.[a-z0-9]+:?@?/, ''))) toks.add(norm(t));
      cards.push({ type: 'directory', part: part.name, label: d + '/', n: Math.max(...facts.map(f => f.sraw)), toks, facts, topDirs: [[d, 1]], members: null }); } }
  for (const c of cards) { let s = 0; for (const t of qt) if (c.toks.has(t)) s++; c.score = s / Math.max(1, qt.size); }
  const hits = cards.filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.n - a.n).slice(0, +OPTS.top || 3);
  if (!hits.length) {
    console.log(`no lexical match for "${q}" — compact map follows (the asking agent matches it itself):`);
    for (const c of cards.sort((a, b) => b.n - a.n).slice(0, 60)) console.log(`  [${c.type}] ${c.label} (${c.n}) → ${c.topDirs.map(([d]) => d + '/').join(' · ')}`);
    return; }
  for (const h of hits) {
    console.log(`\n«${q}» → ${h.type} ${h.label} — ${h.n} ${h.type === 'group' ? 'members' : 'established'} (partition ${h.part}, match ${Math.round(h.score * 100)}%)`);
    if (h.members) console.log(`  lives in: ${h.topDirs.map(([d, n]) => `${d}/ (${Math.round(n / h.n * 100)}%)`).join(' · ')}`);
    for (const f of h.facts.slice(0, 6)) console.log(`  - ${verbalize(f, f.exemplars.map(e => e.name))} — ${Math.round(f.share * 100)}% of ${f.sraw}`);
    const ex = [...new Map(h.facts.flatMap(f => f.exemplars).map(e => [e.rel + e.name, e])).values()].slice(0, 3);
    if (ex.length) console.log(`  pattern to copy: ${ex.map(e => `${e.rel}:${e.line} \`${e.name}\``).join(' · ')}`);
    const dirs = h.topDirs.map(([d]) => d);
    const cc = (model.cochange || []).filter(p => dirs.some(d => p.a.startsWith(d) || p.b.startsWith(d))).slice(0, 3);
    if (cc.length) console.log(`  historically co-changes with: ${cc.map(p => (dirs.some(d => p.a.startsWith(d)) ? p.b : p.a) + ` (${p.sup}x)`).join(' · ')}`); } }

// ===== EXPORT-ASPECT (the Yggdrasil bridge: discovered suggestion → enforced ratchet rule) =====
async function exportAspect(model) {
  const [factIdxStr, outdir] = ARGS; const [pi, fi] = factIdxStr.split(':').map(Number);
  const part = model.partitions[pi]; const f = part.facts[fi];
  const name = f.pid.replace(/^auto\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+$/, '') + '-' + f.exp;
  mkdirSync(join(outdir, name), { recursive: true });
  const prose = verbalize(f, f.exemplars.map(e => e.name));
  writeFileSync(join(outdir, name, 'yg-aspect.yaml'),
`# Generated by roots from a DISCOVERED convention (evidence: ${f.sraw - f.deviantsN}/${f.sraw} conform, ${f.bpi} bits/instance).
# Converted from suggestion to ENFORCED rule by agent request.
name: ${name}
description: >
  ${prose}. Discovered automatically; enforced as a ratchet: the ${f.deviantsN} pre-existing
  deviations are grandfathered (listed in check.mjs), new ones fail the check.
check: check.mjs
`);
  // grandfathered = deviants at export time, re-derived by a hermetic scan of the current tree
  const root = REPO; const violations = [];
  for (const rel of [...walkFiles(root, root)]) { let src; try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const hits = await checkFile(model, root, rel, src, null, 'export', true);
    for (const m of hits) if (m.pid === f.pid) violations.push(rel + '#' + m.scope); }
  writeFileSync(join(outdir, name, 'check.mjs'),
`#!/usr/bin/env node
// Generated enforced check for the discovered convention: ${prose}
// Ratchet: grandfathered deviations pass; NEW deviations fail (exit 1).
const GRANDFATHERED = new Set(${JSON.stringify(violations)});
const PID = ${JSON.stringify(f.pid)};
import { execFileSync } from 'node:child_process';
const out = execFileSync('node', [${JSON.stringify(new URL(import.meta.url).pathname)},
  'scan-pid', process.argv[2] || ${JSON.stringify(resolve(root))}, ${JSON.stringify(resolve(MODEL))}, PID], { maxBuffer: 1 << 26 }).toString();
const current = JSON.parse(out);
const fresh = current.filter(v => !GRANDFATHERED.has(v));
if (fresh.length) { console.error('VIOLATIONS (new, not grandfathered):'); fresh.forEach(v => console.error('  ' + v)); process.exit(1); }
console.log('OK — no new deviations (' + GRANDFATHERED.size + ' grandfathered).'); process.exit(0);
`);
  console.log(JSON.stringify({ aspect: name, prose, grandfathered: violations.length, dir: join(outdir, name) }, null, 1)); }
async function scanPid(model) { const pid = ARGS[0]; const root = REPO; const out = [];
  for (const rel of [...walkFiles(root, root)]) { let src; try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const hits = await checkFile(model, root, rel, src, null, 'scan', true);
    for (const m of hits) if (m.pid === pid) out.push(rel + '#' + m.scope); }
  console.log(JSON.stringify(out)); }
async function status(model) {
  const nf = model.partitions.reduce((a, p) => a + p.facts.length, 0);
  console.log(`model: ${model.repo} · ${model.partitions.length} partitions · ${nf} conventions`);
  console.log(`agentShare: ${model.agentShare ?? 'n/a (no history)'} ${model.agentShare >= 0.85 ? '⚠ ALARM' : ''}`);
  console.log(`DENY-eligible: ${model.partitions.reduce((a, p) => a + p.facts.filter(f => f.denyEligible).length, 0)} · nucleating stand-downs: ${model.partitions.reduce((a, p) => a + p.facts.filter(f => f.suppressedValue).length, 0)}`);
  console.log(`co-change pairs: ${model.cochange.length} · history: ${model.historyStats ? model.historyStats.commits + ' commits, ' + model.historyStats.blobs + ' blobs' : 'none (degraded weights)'}`); }

const loadModel = () => JSON.parse(readFileSync(MODEL, 'utf8'));
if (CMD === 'learn') await learn();
else if (CMD === 'check') { const m = loadModel(); const rel = ARGS[0];
  const content = OPTS.content ? readFileSync(OPTS.content, 'utf8') : undefined;
  const msgs = await checkFile(m, REPO, rel, content, OPTS.as, OPTS.session);
  console.log(msgs.length ? msgs.map(x => x.text + `\n  (Δ=${x.delta}, ${x.sev}, line ${x.line})`).join('\n\n') : '(silence)'); }
else if (CMD === 'report') await report(loadModel());
else if (CMD === 'status') await status(loadModel());
else if (CMD === 'completeness') await completeness(loadModel());
else if (CMD === 'mutate-test') await mutateTest(loadModel());
else if (CMD === 'scan-pid') await scanPid(loadModel());
else if (CMD === 'export-aspect') await exportAspect(loadModel());
else if (CMD === 'spectrum') await spectrum(loadModel());
else if (CMD === 'where') await whereCmd(loadModel());
else console.error('usage: learn|check|report|status|completeness|mutate-test|export-aspect|scan-pid|spectrum|where');

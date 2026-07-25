const { createCanvas } = require('canvas');
const GIFEncoder = require('gifencoder');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'public', 'demo.gif');

const W = 960, H = 540, FPS = 5;

const encoder = new GIFEncoder(W, H);
const stream = encoder.createReadStream().pipe(fs.createWriteStream(OUTPUT));
encoder.start();
encoder.setRepeat(0);
encoder.setDelay(Math.round(1000 / FPS));
encoder.setQuality(10);

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

const BG = '#050508';
const TERM_BG = '#0d1117';
const TERM_BORDER = '#1a1e26';
const TEXT = '#c9d1d9';
const DIM = '#768390';
const GREEN = '#7ee787';
const RED = '#f85149';
const BLUE = '#58a6ff';
const PURPLE = '#bc8cff';
const YELLOW = '#d29922';
const WHITE = '#e6e6e6';
const OUTPUT_C = '#adbac7';

const TX = 30, TY = 20, TW = W - 60, TH = H - 40;
const HEAD_H = 38;
const CONTENT_X = TX + 16;
const LINE_H = 20;
const FONT = '13px monospace';
const FONT_BOLD = 'bold 13px monospace';

let lines = [];
let termTitle = 'terminal';
let bigText = null;

function drawBackground() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTerminal() {
  roundRect(TX, TY, TW, TH, 10);
  ctx.fillStyle = TERM_BG;
  ctx.fill();
  ctx.strokeStyle = TERM_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#151920';
  ctx.fillRect(TX + 1, TY + HEAD_H, TW - 2, 1);

  const dots = [['#ff5f57', TX+16], ['#febc2e', TX+33], ['#28c840', TX+50]];
  for (const [c, x] of dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, TY + 19, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#8b949e';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(termTitle, TX + TW / 2, TY + 23);
  ctx.textAlign = 'left';

  const contentY = TY + HEAD_H + 8;
  const maxLines = Math.floor((TH - HEAD_H - 16) / LINE_H);
  const startLine = Math.max(0, lines.length - maxLines);

  ctx.save();
  ctx.beginPath();
  ctx.rect(TX + 4, contentY - 4, TW - 8, TH - HEAD_H - 8);
  ctx.clip();

  for (let i = startLine; i < lines.length; i++) {
    const y = contentY + (i - startLine) * LINE_H + 14;
    if (y > TY + TH) break;
    const line = lines[i];
    ctx.font = line.bold ? FONT_BOLD : FONT;
    ctx.fillStyle = line.color || TEXT;
    ctx.fillText(line.text, CONTENT_X, y);
  }
  ctx.restore();
}

function drawBigText() {
  if (!bigText) return;
  ctx.textAlign = 'center';
  for (let i = 0; i < bigText.length; i++) {
    const bt = bigText[i];
    ctx.font = bt.font || 'bold 42px sans-serif';
    ctx.fillStyle = bt.color || WHITE;
    ctx.fillText(bt.text, W / 2, H / 2 + i * 50 - ((bigText.length - 1) * 25));
  }
  ctx.textAlign = 'left';
}

function frame() {
  drawBackground();
  if (bigText) drawBigText();
  else drawTerminal();
  encoder.addFrame(ctx);
}

function frames(n) { for (let i = 0; i < n; i++) frame(); }
function add(text, color, bold) { lines.push({ text, color: color || TEXT, bold: !!bold }); }
function clear() { lines = []; }

// ===== SCENE SCRIPT =====
// Narrative: the headline claim is persistence across sessions — "say it once".
// Session 1 shows the loop: the rules reach the agent BEFORE it writes, the check
// refuses something a rules file would have let through, the agent fixes it.
// Session 2 shows the payoff: nobody restates anything, the same rules still hold,
// and the keyless gate passes first try.
//
// Weighting, unchanged from real adopter feedback: prevention first, the free
// deterministic layer visible, the LLM reviewer as ONE beat and never the axis.
//
// Keep it under ~15s. The old cut ran 35s and nobody reached the payoff.
console.log('Rendering...');

// Session 1 — the task. No install, no init: nobody watches that.
termTitle = 'claude code';
add('You: Add a charge endpoint. Payments must emit an', BLUE, true);
add('     audit event and record to the ledger.', BLUE); frames(5);
add('', TEXT);

// The rules arrive before a line is written.
add('Agent: Pulling the rules that touch this file first.', PURPLE); frames(2);
add('', TEXT);
add('\u25b6 yg context --file src/payments/charge.ts', WHITE); frames(2);
add('  node: payments/service', DIM);
add('  requires-audit    [llm]  read: aspects/requires-audit/content.md', OUTPUT_C);
add('  input-validation  [llm]  read: aspects/input-validation/content.md', OUTPUT_C);
add('  no-direct-db      [det]  read: aspects/no-direct-db/check.mjs', OUTPUT_C); frames(5);
add('', TEXT);
add('  src/payments/charge.ts  created', GREEN); frames(3);

// The check catches what a rules file would have let through.
add('', TEXT);
add('\u25b6 yg check --approve', WHITE); frames(2);
add('  [det] no-direct-db    approved  (no cost)', GREEN); frames(1);
add('  [llm] requires-audit  refused', RED, true);
add('    charge() mutates state but never calls emitAudit().', OUTPUT_C); frames(6);
add('', TEXT);
add('Agent: Missing the audit event. Adding it.', PURPLE); frames(2);
add('  src/payments/charge.ts  modified', YELLOW); frames(2);
add('  yg check: PASS  1 nodes \u00b7 2/2 files \u00b7 3 aspects \u00b7 0 flows', GREEN, true); frames(5);

// The session boundary. This is the whole point of the demo.
clear();
bigText = [
  { text: 'Next week. New session.', color: WHITE, font: 'bold 30px sans-serif' },
  { text: 'Nobody restates the rules.', color: '#888', font: '20px sans-serif' },
]; frames(7);

// Session 2 — it holds, first try, with no key.
// NOTE: bigText stays drawn until it is cleared, so reset it before any
// terminal scene that follows a card.
bigText = null;
clear(); termTitle = 'claude code'; frames(1);
add('You: Add a refund endpoint.', BLUE, true); frames(4);
add('', TEXT);
add('Agent: Same three rules apply here. Writing to them.', PURPLE); frames(3);
add('  src/payments/refund.ts  created', GREEN); frames(3);
add('', TEXT);
add('\u25b6 yg check   # the gate \u2014 no LLM, no keys', WHITE); frames(2);
add('  yg check: PASS  1 nodes \u00b7 3/3 files \u00b7 3 aspects \u00b7 0 flows', GREEN, true); frames(6);

// Punchline.
clear();
bigText = [
  { text: 'Say it once.', color: WHITE, font: '900 46px sans-serif' },
  { text: 'The rule you wrote last week is still enforced today.', color: '#888', font: '20px sans-serif' },
  { text: 'npm install -g @chrisdudek/yg', color: GREEN, font: '14px monospace' },
]; frames(13);

encoder.finish();
console.log('Done. Waiting for file write...');
stream.on('finish', () => {
  const size = fs.statSync(OUTPUT).size;
  console.log(`GIF saved: ${(size / 1024 / 1024).toFixed(1)}MB`);
});

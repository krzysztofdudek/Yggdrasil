import { walk, report } from '@chrisdudek/yg/ast';

/**
 * No raw process exit in the command layer.
 *
 * A command ends the process in one of two ways, and only these two:
 *
 *   - failAndExit(diagnostic) — the error, in the one error grammar, then exit 1
 *     (cli/output.ts);
 *   - exitAfterFlush(code) — wait for stdout to drain, then exit with the code
 *     (cli/exit-after-flush.ts), for any exit that follows output.
 *
 * A bare `process.exit(...)` ends the process at once. When stdout or stderr is
 * a pipe (an agent capturing the output, `| head`, CI), whatever the process
 * wrote that the reader has not taken yet is still queued inside the process —
 * everything past the pipe's buffer, 64 KiB on Linux — and exiting drops it
 * silently, exactly when the output is longest. The helpers exist so that can
 * not happen, and so there is one exit convention to read instead of two.
 *
 * Scope: every .ts file under source/cli/src/cli/, so a command written
 * tomorrow is covered the day it is written. A call AND a bare reference are
 * refused (`.finally(process.exit)` exits just the same).
 *
 * The allowed sites below are the helpers themselves and two exits that are
 * not the end of a command's answer. Each is allowed exactly as many raw exits
 * as it has today, so a second one in the same file is still refused.
 */

const GUARDED_PREFIX = 'source/cli/src/cli/';

const ALLOWED = new Map([
  // failAndExit: the error is written synchronously before it — it is the
  // command layer's one synchronous error exit, called from assertion helpers
  // that must not return.
  ['source/cli/src/cli/output.ts', 1],
  // exitAfterFlush's own backstop: an unref'd timer that forces the exit only
  // when some other handle keeps the process alive after stdout drained.
  ['source/cli/src/cli/exit-after-flush.ts', 1],
  // The portal's Ctrl+C / SIGTERM shutdown: it ends a long-lived server after
  // closing it, when nothing of an answer is left to write.
  ['source/cli/src/cli/portal.ts', 1],
  // A cancelled interactive setup prompt (Ctrl+C in the menu, a terminal):
  // a synchronous assertion that must not return, exit 0 as the user asked.
  ['source/cli/src/cli/init-reviewer-setup.ts', 1],
]);

function flat(text) {
  return text.replace(/\s+/g, '');
}

/** `process.exit`, `process?.exit`, `globalThis.process.exit`, `process['exit']`. */
function isProcessExit(node) {
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (!obj || !prop || prop.text !== 'exit') return false;
    const o = flat(obj.text);
    return o === 'process' || o.endsWith('.process');
  }
  if (node.type === 'subscript_expression') {
    const obj = node.childForFieldName('object');
    const index = node.childForFieldName('index');
    if (!obj || !index) return false;
    const o = flat(obj.text);
    return (o === 'process' || o.endsWith('.process')) && /^['"`]exit['"`]$/.test(index.text);
  }
  return false;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!file.path.startsWith(GUARDED_PREFIX) || !file.path.endsWith('.ts')) continue;
    const allowed = ALLOWED.get(file.path) ?? 0;
    const sites = [];
    walk(file.ast.rootNode, (node) => {
      if (isProcessExit(node)) sites.push(node);
    });
    for (const node of sites.slice(allowed)) {
      violations.push(
        report(
          file,
          node,
          allowed === 0
            ? `raw ${flat(node.text)} in the command layer — end the command with failAndExit(diagnostic) from cli/output.ts for an error, or await exitAfterFlush(code) from cli/exit-after-flush.ts after output, so nothing written to a pipe is dropped`
            : `a further raw ${flat(node.text)} in ${file.path} — this file is allowed ${allowed} (listed in the rule), and this one is not it; use failAndExit or exitAfterFlush`,
        ),
      );
    }
  }
  return violations;
}

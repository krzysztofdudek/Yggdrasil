import { failAndExit, writeOut } from './output.js';
import { exitAfterFlush } from './exit-after-flush.js';

export async function show(name: string, lines: string[] | undefined): Promise<void> {
  if (lines === undefined) {
    failAndExit({ what: `widget '${name}' is not in the graph`, why: 'The command needs it.', next: 'yg tree' });
  }
  writeOut(lines.join('\n'));
  // process.exit(0) would drop what a pipe has not read yet.
  await exitAfterFlush(0);
}

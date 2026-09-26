import { fail } from './output.js';

export function refuse(name: string): void {
  fail({ what: `widget '${name}' is not in the graph`, why: 'The command needs it.', next: 'yg tree' });
  process.exit(1);
}

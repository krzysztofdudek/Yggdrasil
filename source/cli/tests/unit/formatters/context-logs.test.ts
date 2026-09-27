import { describe, it, expect } from 'vitest';
import { formatContextLogs } from '../../../src/formatters/context-logs.js';

const broken = { what: 'x/log.md is broken', why: 'it does not parse', next: 'fix x/log.md' };

describe('formatContextLogs', () => {
  it('gives nothing when there is no log', () => {
    expect(formatContextLogs({ typeDecisions: [] })).toEqual([]);
  });

  it('puts each type under its own heading, nearest first, then the node log, each entry indented under its datetime', () => {
    const lines = formatContextLogs({
      typeDecisions: [
        { typeId: 'service', logPath: '.yggdrasil/types/service/log.md', entries: [{ datetime: 'D1', body: '\nFirst line.\n\nSecond paragraph.\n' }] },
        { typeId: 'module', logPath: '.yggdrasil/types/module/log.md', entries: [{ datetime: 'D0', body: 'Up.\n' }] },
      ],
      nodeLog: { nodePath: 'services/orders', logPath: '.yggdrasil/model/services/orders/log.md', entries: [{ datetime: 'D2', body: 'Why.\n' }], trimmed: false, omitted: 0 },
    }, '  ');
    expect(lines[0]).toBe("  Decisions in force for type 'service' (.yggdrasil/types/service/log.md):");
    expect(lines.slice(1, 5)).toEqual(['    [D1]', '      First line.', '', '      Second paragraph.']);
    expect(lines.findIndex((l) => l.includes("type 'module' — a type above"))).toBeGreaterThan(0);
    expect(lines.at(-3)).toBe('    [D2]');
    expect(lines.some((l) => l.includes('next:'))).toBe(false);
  });

  it('names the entries a trim left out and the command that reads them', () => {
    const lines = formatContextLogs({
      typeDecisions: [],
      nodeLog: { nodePath: 'a/b', logPath: '.yggdrasil/model/a/b/log.md', entries: [{ datetime: 'D', body: 'x' }], trimmed: true, omitted: 1 },
    });
    expect(lines).toContain('  next: yg log read --node a/b --all');
    expect(lines.some((l) => l.startsWith('  1 older entry not shown'))).toBe(true);
  });

  it('renders an unreadable log in the what / why / next grammar, for a type and for a node', () => {
    const lines = formatContextLogs({
      typeDecisions: [{ typeId: 't', logPath: '.yggdrasil/types/t/log.md', entries: [], unreadable: broken }],
      nodeLog: { nodePath: 'a', logPath: '.yggdrasil/model/a/log.md', entries: [], trimmed: false, omitted: 0, unreadable: broken },
    });
    expect(lines.filter((l) => l === '  next: fix x/log.md')).toHaveLength(2);
    expect(lines.filter((l) => l === '    why:  it does not parse')).toHaveLength(2);
  });
});

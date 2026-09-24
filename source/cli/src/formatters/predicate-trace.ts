import type { PredicateTrace } from '../model/file-when.js';

/**
 * Render a predicate evaluation trace as an indented ✓/✗ tree.
 * Used in error messages to show which clauses passed/failed.
 */
export function renderTrace(trace: PredicateTrace, indent = ''): string {
  const lines: string[] = [];
  renderNode(trace, indent, lines);
  return lines.join('\n');
}

/**
 * The same trace on one line, for a what/why/next message: the renderer lays a
 * message out, so a message carries no indentation of its own. A group reads
 * `✗ all_of [✓ path matches "src/**", ✗ content does not match "x"]`.
 */
export function renderTraceInline(trace: PredicateTrace): string {
  const mark = trace.result ? '✓' : '✗';
  switch (trace.kind) {
    case 'atom-path':
    case 'atom-content': {
      const verb = trace.result ? 'matches' : 'does not match';
      const detail = trace.detail ? ` (${trace.detail})` : '';
      return `${mark} ${trace.kind === 'atom-path' ? 'path' : 'content'} ${verb} "${trace.pattern}"${detail}`;
    }
    case 'all_of':
    case 'any_of':
      return `${mark} ${trace.kind} [${trace.children.map(renderTraceInline).join(', ')}]`;
    case 'not':
      return `${mark} not [${renderTraceInline(trace.child)}]`;
    case 'exempt':
      return `${mark} exempt: ${trace.reason}`;
  }
}

function renderNode(node: PredicateTrace, indent: string, lines: string[]): void {
  const mark = node.result ? '✓' : '✗';

  switch (node.kind) {
    case 'atom-path': {
      const verb = node.result ? 'matches' : 'does not match';
      const detail = node.detail ? ` (${node.detail})` : '';
      lines.push(`${indent}${mark} path ${verb} "${node.pattern}"${detail}`);
      break;
    }
    case 'atom-content': {
      const verb = node.result ? 'matches' : 'does not match';
      const detail = node.detail ? ` (${node.detail})` : '';
      lines.push(`${indent}${mark} content ${verb} "${node.pattern}"${detail}`);
      break;
    }
    case 'all_of': {
      lines.push(`${indent}${mark} all_of:`);
      for (const child of node.children) {
        renderNode(child, indent + '    ', lines);
      }
      break;
    }
    case 'any_of': {
      lines.push(`${indent}${mark} any_of:`);
      for (const child of node.children) {
        renderNode(child, indent + '    ', lines);
      }
      break;
    }
    case 'not': {
      lines.push(`${indent}${mark} not:`);
      renderNode(node.child, indent + '    ', lines);
      break;
    }
    case 'exempt': {
      lines.push(`${indent}${mark} exempt: ${node.reason}`);
      break;
    }
  }
}

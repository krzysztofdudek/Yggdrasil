export interface FileContextData {
  filePath: string;
  ownerPath?: string;
  ownerType?: string;
  aspects: FileContextAspect[];
  dependencies: FileContextDep[];
  dependentCount: number;
  candidates?: Array<{ nodePath: string; mappingPrefix: string }>;
}

export interface FileContextAspect {
  aspectId: string;
  aspectDescription: string;
  verifiedAgainst: string;
  source?: string; // for implied aspects
}

export interface FileContextDep {
  path: string;
  consumed: string[];
}

export function formatFileContext(data: FileContextData): string {
  const lines: string[] = [];

  lines.push(data.filePath);
  if (data.ownerPath) {
    lines.push(`  Owner: ${data.ownerPath} (${data.ownerType ?? 'unknown'})`);
  } else {
    lines.push('  Owner: unmapped');
    lines.push('');
    if (data.candidates && data.candidates.length > 0) {
      lines.push('  This file is not covered by any node.');
      lines.push('  Candidate nodes (by directory):');
      for (const c of data.candidates) {
        lines.push(`    ${c.nodePath} — ${c.mappingPrefix}`);
      }
      lines.push('  Add this file to a candidate node\'s mapping in yg-node.yaml, or create a new node.');
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push('Must satisfy:');
    lines.push('');
    for (const aspect of data.aspects) {
      lines.push(`  ${aspect.aspectId} — ${aspect.aspectDescription}`);
      lines.push(`    read: ${aspect.verifiedAgainst}`);
      if (aspect.source) {
        lines.push(`    Source: ${aspect.source}`);
      }
      lines.push('');
    }
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push('Dependencies consumed:');
    for (const dep of data.dependencies) {
      lines.push(`  ${dep.path} — ${dep.consumed.join(', ')}`);
    }
    lines.push('');
  }

  // Dependents
  if (data.dependentCount > 0) {
    lines.push(`Dependents: ${data.dependentCount} nodes — run yg impact --file ${data.filePath}`);
    lines.push('');
  }

  // Back-pointer
  lines.push(`Node context: run yg context --node ${data.ownerPath}`);
  lines.push('');

  return lines.join('\n');
}

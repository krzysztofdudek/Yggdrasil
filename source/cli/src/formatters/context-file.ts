export interface FileContextData {
  filePath: string;
  ownerPath?: string;
  ownerType?: string;
  claims: FileContextAspect[];
  dependencies: FileContextDep[];
  dependentCount: number;
  candidates?: Array<{ nodePath: string; mappingPrefix: string }>;
}

export interface FileContextAspect {
  aspectId: string;
  aspectDescription: string;
  verifiedAgainst: string;
  source?: string; // for implied aspects
  claims: string[];
}

export interface FileContextDep {
  path: string;
  consumed: string[];
  portClaims?: FileContextPortClaim[];
}

export interface FileContextPortClaim {
  aspectId: string;
  aspectDescription: string;
  verifiedAgainst: string;
  claims: string[];
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
      lines.push('  Or create a new node. See: yg check for E022 details.');
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');

  // Claims
  if (data.claims.length > 0) {
    lines.push('Claims to satisfy:');
    lines.push('');
    for (const aspect of data.claims) {
      lines.push(`  ${aspect.aspectId} — ${aspect.aspectDescription}`);
      lines.push(`    Verified against: ${aspect.verifiedAgainst}`);
      if (aspect.source) {
        lines.push(`    Source: ${aspect.source}`);
      }
      for (const claim of aspect.claims) {
        lines.push(`    - "${claim}"`);
      }
      lines.push('');
    }
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push('Dependencies consumed:');
    for (const dep of data.dependencies) {
      lines.push(`  ${dep.path} — ${dep.consumed.join(', ')}`);
      if (dep.portClaims && dep.portClaims.length > 0) {
        lines.push('    Claims to satisfy:');
        for (const pc of dep.portClaims) {
          lines.push(`      ${pc.aspectId} — ${pc.aspectDescription}`);
          lines.push(`        Verified against: ${pc.verifiedAgainst}`);
          for (const claim of pc.claims) {
            lines.push(`        - "${claim}"`);
          }
        }
      }
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

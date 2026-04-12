export interface NodeContextData {
  path: string;
  name: string;
  type: string;
  description?: string;
  sourceFiles: string[];
  aspects: NodeContextAspect[];
  flows: NodeContextFlow[];
  dependencies: NodeContextDep[];
  dependentCount: number;
  dependentPaths?: string[]; // populated when <= 5 dependents (plain list)
  parentPath?: string;
  parentType?: string;
  parentReadPath?: string;
}

export interface NodeContextAspect {
  id: string;
  name: string;
  description: string;
  source: string;
  verifiedAgainst: string;
  implies?: string[];
}

export interface NodeContextFlow {
  id: string;
  name: string;
  description: string;
  readPath: string;
}

export interface NodeContextDep {
  path: string;
  relation: string;
  description?: string;
  readPath?: string;
  consumes?: string[];
  portAspects?: Array<{ aspectId: string; verifiedAgainst: string }>;
}

export function formatNodeContext(data: NodeContextData): string {
  const lines: string[] = [];

  // Header
  const desc = data.description ? ` — ${data.description}` : '';
  lines.push(`${data.path}${desc} (${data.type})`);
  lines.push('');

  // Source files
  lines.push(`Source files (${data.sourceFiles.length}):`);
  for (const f of data.sourceFiles) {
    lines.push(`  ${f}`);
  }
  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push(`Must satisfy (${data.aspects.length} aspect${data.aspects.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const aspect of data.aspects) {
      lines.push(`  ${aspect.id} — ${aspect.description}`);
      lines.push(`    Source: ${aspect.source}`);
      lines.push(`    read: ${aspect.verifiedAgainst}`);
      if (aspect.implies && aspect.implies.length > 0) {
        lines.push(`    Implies: ${aspect.implies.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Flows
  if (data.flows.length > 0) {
    lines.push(`Participates in (${data.flows.length} flow${data.flows.length === 1 ? '' : 's'}):`);
    for (const flow of data.flows) {
      lines.push(`  ${flow.id} — ${flow.description}`);
      lines.push(`    read: ${flow.readPath}`);
    }
    lines.push('');
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push(`Dependencies (${data.dependencies.length}):`);
    for (const dep of data.dependencies) {
      const depDesc = dep.description ? ` — ${dep.description}` : '';
      const consumes = dep.consumes ? ` — consumes: ${dep.consumes.join(', ')}` : '';
      lines.push(`  ${dep.path} (${dep.relation})${depDesc}${consumes}`);
      if (dep.portAspects && dep.portAspects.length > 0) {
        for (const pa of dep.portAspects) {
          lines.push(`    Required: ${pa.aspectId}`);
        }
      }
      if (dep.readPath) {
        lines.push(`    read: ${dep.readPath}`);
      }
    }
    lines.push('');
  }

  // Dependents with consequence framing
  if (data.dependentCount > 0) {
    lines.push(`Dependents (${data.dependentCount}):`);
    if (data.dependentCount >= 16) {
      lines.push(`  HIGH blast radius — changes cascade to ${data.dependentCount} nodes.`);
      lines.push(`  Strongly recommended: yg impact --node ${data.path}`);
    } else if (data.dependentCount >= 6) {
      lines.push(`  Moderate blast radius — changes trigger cascade review on ${data.dependentCount} nodes.`);
      lines.push(`  Run: yg impact --node ${data.path}`);
    } else {
      // 1-5: plain list of dependent node paths
      for (const dep of data.dependentPaths ?? []) {
        lines.push(`  ${dep}`);
      }
      lines.push(`  Run: yg impact --node ${data.path}`);
    }
    lines.push('');
  }

  // Parent
  if (data.parentPath) {
    lines.push(`Parent: ${data.parentPath} (${data.parentType ?? 'module'})`);
    if (data.parentReadPath) {
      lines.push(`  read: ${data.parentReadPath}`);
    }
    lines.push('');
  }

  // Workflow footer
  lines.push(`After modifying source files in this node: run yg check, then yg approve --node ${data.path}`);
  lines.push('');

  return lines.join('\n');
}

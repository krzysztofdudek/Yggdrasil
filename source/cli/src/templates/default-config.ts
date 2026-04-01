import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function resolveProjectName(projectRoot: string): Promise<string> {
  // Try package.json name
  try {
    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) {
      const raw = pkg.name.trim();
      // For scoped packages like @documenso/root: use scope name if bare name is generic
      const scopeMatch = raw.match(/^@([^/]+)\/(.+)$/);
      if (scopeMatch) {
        const [, scope, bare] = scopeMatch;
        const generic = ['root', 'app', 'main', 'monorepo', 'workspace'];
        return generic.includes(bare) ? scope : bare;
      }
      return raw;
    }
  } catch { /* no package.json or invalid */ }

  // Fall back to directory name
  return path.basename(projectRoot);
}

export const DEFAULT_CONFIG = `version: "4.0.0"

name: ""

node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors — invisible in call graphs but affect blast radius"

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
    own_warning: 5000
`;

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';

export async function migrateToV4(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  // Step 1: Migrate config — extract node_types to architecture file, remove from config
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  if (await fileExists(configPath)) {
    await migrateConfig(configPath, yggRoot, actions, warnings);
  }

  // Step 2: Transform all yg-node.yaml files
  const modelDir = path.join(yggRoot, 'model');
  if (await fileExists(modelDir)) {
    await transformNodeFiles(modelDir, actions, warnings);
  }

  // Step 3: Migrate architecture file — remove integration_aspects
  const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
  if (await fileExists(architecturePath)) {
    await migrateArchitecture(architecturePath, actions, warnings);
  }

  // Step 4: Create yg-secrets.example.yaml
  await createSecretsExample(yggRoot, actions, warnings);

  // Step 5: Update .gitignore to include yg-secrets.yaml
  await updateGitignore(yggRoot, actions, warnings);

  return { actions, warnings };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function migrateConfig(configPath: string, yggRoot: string, actions: string[], warnings: string[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return;
  }

  const config = parseYaml(content) as Record<string, unknown> | null;
  if (!config || typeof config !== 'object') {
    warnings.push(`Skipped config migration: not a valid YAML object`);
    return;
  }

  let configChanged = false;

  // If node_types exists in config, extract to architecture file
  if (config.node_types && typeof config.node_types === 'object') {
    const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
    const architectureExists = await fileExists(architecturePath);

    if (!architectureExists) {
      // Create yg-architecture.yaml with the node_types
      const architecture = {
        node_types: config.node_types,
      };
      await writeFile(architecturePath, stringifyYaml(architecture, { lineWidth: 120 }), 'utf-8');
      actions.push('Created yg-architecture.yaml from config node_types');
    }

    // Remove node_types from config
    delete config.node_types;
    configChanged = true;
  }

  // Add LLM config placeholder if not present
  if (!config.llm) {
    config.llm = {
      provider: 'ollama',
      model: 'llama3.1:8b',
      endpoint: 'http://localhost:11434',
      temperature: 0,
      consensus: 1,
      max_tokens: 'auto',
    };
    configChanged = true;
    warnings.push(`Added LLM config placeholder to yg-config.yaml (commented out, needs configuration)`);
  }

  // Write config if changed
  if (configChanged) {
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 120 }), 'utf-8');
    if (!config.node_types) {
      actions.push('Removed node_types from yg-config.yaml');
    }
  }
}

async function transformNodeFiles(dir: string, actions: string[], warnings: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await transformNodeFiles(fullPath, actions, warnings);
    } else if (entry.name === 'yg-node.yaml') {
      await transformSingleNode(fullPath, actions, warnings);
    }
  }
}

async function transformSingleNode(filePath: string, actions: string[], warnings: string[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  const doc = parseYaml(content) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') {
    warnings.push(`Skipped ${filePath}: not a valid YAML object`);
    return;
  }

  let changed = false;

  // Step 1: Convert mapping from object to array if needed
  // v3: mapping: {paths: [...]} → v4: mapping: [{paths: [...]}]
  if (doc.mapping && typeof doc.mapping === 'object' && !Array.isArray(doc.mapping)) {
    const mappingObj = doc.mapping as Record<string, unknown>;
    // Only wrap if it has 'paths' and is not an array
    if (mappingObj.paths && Array.isArray(mappingObj.paths)) {
      doc.mapping = [mappingObj];
      changed = true;
    }
  }

  // Step 2: Transform aspects structure
  // v3 can have: aspects: [{aspect: "id", anchors: {...}}] or aspects: ["id"]
  // v4 needs: aspects: ["id"] (flat array of strings)
  if (Array.isArray(doc.aspects) && doc.aspects.length > 0) {
    const aspectsList: string[] = [];

    for (const aspectEntry of doc.aspects as unknown[]) {
      if (typeof aspectEntry === 'string') {
        // Already in v4 format
        aspectsList.push(aspectEntry);
      } else if (typeof aspectEntry === 'object' && aspectEntry !== null) {
        const entry = aspectEntry as Record<string, unknown>;
        const aspectId = entry.aspect;
        if (typeof aspectId === 'string') {
          aspectsList.push(aspectId);
        }
      }
    }

    // Convert aspects to flat string array (v4 format)
    if (aspectsList.length > 0) {
      doc.aspects = aspectsList;
      changed = true;
    } else if (aspectsList.length === 0) {
      delete doc.aspects;
      changed = true;
    }
  }

  // Step 3: Migrate bare-string anchors to typed objects within mapping groups
  if (Array.isArray(doc.mapping)) {
    for (const group of doc.mapping as unknown[]) {
      if (typeof group === 'object' && group !== null) {
        const groupObj = group as Record<string, unknown>;
        if (Array.isArray(groupObj.aspects)) {
          for (const aspectEntry of groupObj.aspects as unknown[]) {
            if (typeof aspectEntry === 'object' && aspectEntry !== null) {
              const aspect = aspectEntry as Record<string, unknown>;
              if (aspect.anchors) {
                // anchors can be either an array of strings or an object
                if (Array.isArray(aspect.anchors)) {
                  // Convert array format to object format
                  const anchorsObj = convertAnchorArrayToObject(aspect.anchors);
                  aspect.anchors = migrateAnchors(anchorsObj);
                  changed = true;
                } else if (typeof aspect.anchors === 'object') {
                  const anchorsObj = aspect.anchors as Record<string, unknown>;
                  const migrated = migrateAnchors(anchorsObj);
                  if (migrated !== anchorsObj) {
                    aspect.anchors = migrated;
                    changed = true;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Step 4: Remove deprecated fields
  const deprecatedFields = ['exceptions', 'integration_anchors', 'tags', 'integration_aspects'];
  for (const field of deprecatedFields) {
    if (field in doc) {
      delete doc[field];
      changed = true;
      if (field === 'integration_aspects') {
        warnings.push(`Removed integration_aspects from node`);
      }
    }
  }

  // Step 5: Remove anchors from relations (moved to relation realizations in v4)
  if (Array.isArray(doc.relations)) {
    for (const relation of doc.relations as unknown[]) {
      if (typeof relation === 'object' && relation !== null) {
        const rel = relation as Record<string, unknown>;
        if ('anchors' in rel) {
          // In v4, relation anchors become part of the relation object itself
          // Just remove the old format, actual anchor structure should already be correct
          delete rel.anchors;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await writeFile(filePath, stringifyYaml(doc, { lineWidth: 120 }), 'utf-8');
    const nodeDir = path.basename(path.dirname(filePath));
    actions.push(`Transformed ${nodeDir}/yg-node.yaml to v4 format`);
  }
}

/**
 * Convert anchor array format to object format
 * Input: ["audit-entry", "log-call"]
 * Output: {audit-entry: "audit-entry", log-call: "log-call"}
 */
function convertAnchorArrayToObject(anchorsArray: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const anchor of anchorsArray) {
    if (typeof anchor === 'string' && anchor.trim() !== '') {
      result[anchor] = anchor;
    }
  }
  return result;
}

/**
 * Migrate anchors from various formats to v4 typed format
 * v3 input: {id: "pattern"} or {id: {regex: "pattern", rationale: "..."}}
 * v4 output: {id: {regex: "pattern", rationale: "..."}} always
 */
function migrateAnchors(anchorsObj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let changed = false;

  for (const [id, value] of Object.entries(anchorsObj)) {
    if (typeof value === 'string') {
      // v3 bare string format
      result[id] = { regex: value, rationale: 'migrated from v3' };
      changed = true;
    } else if (typeof value === 'object' && value !== null) {
      const valueObj = value as Record<string, unknown>;
      // Already in typed format (has 'regex' or other type)
      if ('regex' in valueObj) {
        // Already correct format
        result[id] = value;
      } else {
        // Unknown format, try to preserve
        result[id] = value;
      }
    } else {
      // Unknown format, preserve as-is
      result[id] = value;
    }
  }

  return changed ? result : anchorsObj;
}

/**
 * Migrate architecture file: remove integration_aspects from node_types
 */
async function migrateArchitecture(archPath: string, actions: string[], warnings: string[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(archPath, 'utf-8');
  } catch {
    return;
  }

  const arch = parseYaml(content) as Record<string, unknown> | null;
  if (!arch || typeof arch !== 'object') {
    warnings.push(`Skipped architecture migration: not a valid YAML object`);
    return;
  }

  let changed = false;

  if (arch.node_types && typeof arch.node_types === 'object') {
    const nodeTypes = arch.node_types as Record<string, unknown>;
    for (const [, nodeType] of Object.entries(nodeTypes)) {
      if (typeof nodeType === 'object' && nodeType !== null) {
        const typeObj = nodeType as Record<string, unknown>;
        if ('integration_aspects' in typeObj) {
          delete typeObj.integration_aspects;
          changed = true;
          warnings.push(`Removed integration_aspects from architecture node_types`);
        }
      }
    }
  }

  if (changed) {
    await writeFile(archPath, stringifyYaml(arch, { lineWidth: 120 }), 'utf-8');
    actions.push('Removed integration_aspects from yg-architecture.yaml');
  }
}

/**
 * Create yg-secrets.example.yaml with template content
 */
async function createSecretsExample(yggRoot: string, actions: string[], warnings: string[]): Promise<void> {
  const secretsExamplePath = path.join(yggRoot, 'yg-secrets.example.yaml');

  const template = `# Copy this to yg-secrets.yaml and fill in sensitive values (never commit yg-secrets.yaml)
llm:
  api_key: <your-api-key>
  provider: openai    # or: ollama, anthropic
  model: gpt-4        # override if needed
`;

  try {
    await writeFile(secretsExamplePath, template, 'utf-8');
    actions.push('Created yg-secrets.example.yaml');
  } catch (err) {
    warnings.push(`Failed to create yg-secrets.example.yaml: ${(err as Error).message}`);
  }
}

/**
 * Update .gitignore to include yg-secrets.yaml
 */
async function updateGitignore(yggRoot: string, actions: string[], warnings: string[]): Promise<void> {
  const gitignorePath = path.join(yggRoot, '.gitignore');
  const gitignoreEntry = 'yg-secrets.yaml\n';

  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist, we'll create it
  }

  // Check if entry already exists
  if (content.includes('yg-secrets.yaml')) {
    return; // Already present
  }

  // Append entry
  const newContent = content.endsWith('\n') ? content + gitignoreEntry : content + '\n' + gitignoreEntry;

  try {
    await writeFile(gitignorePath, newContent, 'utf-8');
    actions.push('Added yg-secrets.yaml to .yggdrasil/.gitignore');
  } catch (err) {
    warnings.push(`Failed to update .gitignore: ${(err as Error).message}`);
  }
}


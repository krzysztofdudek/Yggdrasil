import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function transformNodeFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await transformNodeFiles(fullPath);
    } else if (entry.name === 'yg-node.yaml') {
      await migrateNodeMapping(fullPath);
    }
  }
}

async function migrateNodeMapping(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  const doc = parseYaml(content);
  if (!doc || typeof doc !== 'object') {
    console.log(`⚠ Skipped ${filePath}: not a valid YAML object`);
    return;
  }

  if (!doc.mapping) {
    return; // No mapping field
  }

  // Check if already migrated (mapping is array)
  if (Array.isArray(doc.mapping)) {
    return; // Already in new format
  }

  // Old format: mapping is an object with 'paths' key
  if (typeof doc.mapping === 'object' && !Array.isArray(doc.mapping) && doc.mapping.paths) {
    const oldPaths = doc.mapping.paths;
    if (Array.isArray(oldPaths)) {
      // Convert to new format: mapping is an array of groups
      doc.mapping = [
        {
          paths: oldPaths
        }
      ];

      await writeFile(filePath, stringifyYaml(doc, { lineWidth: 120 }), 'utf-8');
      const nodeDir = path.basename(path.dirname(filePath));
      console.log(`✓ Migrated mapping in ${nodeDir}/yg-node.yaml`);
    }
  }
}

const modelDir = path.join(process.cwd(), '.yggdrasil', 'model');
if (await fileExists(modelDir)) {
  await transformNodeFiles(modelDir);
  console.log('Migration complete.');
} else {
  console.log('No model directory found.');
}

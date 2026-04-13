import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Graph,
  GraphNode,
  AspectDef,
  FlowDef,
  SchemaDef,
  YggConfig,
  ArchitectureDef,
} from '../model/graph.js';
import { parseConfig } from '../io/config-parser.js';
import { parseNodeYaml } from '../io/node-parser.js';
import { parseAspect } from '../io/aspect-parser.js';
import { parseFlow } from '../io/flow-parser.js';
import { parseSchema } from '../io/schema-parser.js';
import { parseArchitecture } from '../io/architecture-parser.js';
import { findYggRoot } from '../utils/paths.js';

function toModelPath(absolutePath: string, modelDir: string): string {
  return path.relative(modelDir, absolutePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

const FALLBACK_CONFIG: YggConfig = {};

export async function loadGraph(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean } = {},
): Promise<Graph> {
  const yggRoot = await findYggRoot(projectRoot);
  let configError: string | undefined;
  let config = FALLBACK_CONFIG;
  try {
    config = await parseConfig(path.join(yggRoot, 'yg-config.yaml'));
  } catch (error) {
    if (!options.tolerateInvalidConfig) {
      throw error;
    }
    configError = (error as Error).message;
  }

  const { architecture, error: architectureError } = await loadArchitecture(yggRoot);

  const modelDir = path.join(yggRoot, 'model');
  const nodes = new Map<string, GraphNode>();
  const nodeParseErrors: Array<{ nodePath: string; message: string }> = [];
  try {
    await scanModelDirectory(modelDir, modelDir, null, nodes, nodeParseErrors);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Directory .yggdrasil/model/ does not exist. Run 'yg init' first.`, {
        cause: err,
      });
    }
    throw err;
  }

  const aspects = await loadAspects(path.join(yggRoot, 'aspects'));
  const flows = await loadFlows(path.join(yggRoot, 'flows'));
  const schemas = await loadSchemas(path.join(yggRoot, 'schemas'));

  return {
    config,
    architecture,
    architectureError,
    configError,
    nodeParseErrors: nodeParseErrors.length > 0 ? nodeParseErrors : undefined,
    nodes,
    aspects,
    flows,
    schemas,
    rootPath: yggRoot,
  };
}

async function loadArchitecture(
  yggRoot: string,
): Promise<{ architecture: ArchitectureDef; error?: string }> {
  const architectureFilePath = path.join(yggRoot, 'yg-architecture.yaml');
  const emptyArch: ArchitectureDef = { node_types: {} };

  try {
    const architecture = await parseArchitecture(architectureFilePath);
    return { architecture };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { architecture: emptyArch };
    }
    return { architecture: emptyArch, error: (error as Error).message };
  }
}

async function scanModelDirectory(
  dirPath: string,
  modelDir: string,
  parent: GraphNode | null,
  nodes: Map<string, GraphNode>,
  nodeParseErrors: Array<{ nodePath: string; message: string }>,
): Promise<void> {
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

  if (!hasNodeYaml && dirPath !== modelDir) {
    return;
  }

  if (hasNodeYaml) {
    const graphPath = toModelPath(dirPath, modelDir);
    const nodeYamlPath = path.join(dirPath, 'yg-node.yaml');
    let meta;
    let nodeYamlRaw: string | undefined;
    try {
      nodeYamlRaw = await readFile(nodeYamlPath, 'utf-8');
      meta = await parseNodeYaml(nodeYamlPath);
    } catch (err) {
      nodeParseErrors.push({
        nodePath: graphPath,
        message: (err as Error).message,
      });
      return;
    }

    const node: GraphNode = {
      path: graphPath,
      meta,
      nodeYamlRaw,
      children: [],
      parent,
    };

    nodes.set(graphPath, node);
    if (parent) {
      parent.children.push(node);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      await scanModelDirectory(
        path.join(dirPath, entry.name),
        modelDir,
        node,
        nodes,
        nodeParseErrors,
      );
    }
  } else {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      await scanModelDirectory(
        path.join(dirPath, entry.name),
        modelDir,
        null,
        nodes,
        nodeParseErrors,
      );
    }
  }
}

async function loadAspects(aspectsDir: string): Promise<AspectDef[]> {
  try {
    const aspects: AspectDef[] = [];
    await scanAspectsDirectory(aspectsDir, aspectsDir, aspects);
    return aspects;
  } catch {
    return [];
  }
}

async function scanAspectsDirectory(
  dirPath: string,
  aspectsRoot: string,
  aspects: AspectDef[],
): Promise<void> {
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const hasAspectYaml = entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml');

  if (hasAspectYaml) {
    const id = path.relative(aspectsRoot, dirPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const aspectYamlPath = path.join(dirPath, 'yg-aspect.yaml');
    const aspect = await parseAspect(dirPath, aspectYamlPath, id);
    aspects.push(aspect);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    await scanAspectsDirectory(path.join(dirPath, entry.name), aspectsRoot, aspects);
  }
}

async function loadFlows(flowsDir: string): Promise<FlowDef[]> {
  let entries;
  try {
    entries = (await readdir(flowsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return []; // flows/ directory does not exist — OK
  }
  const flows: FlowDef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flowYamlPath = path.join(flowsDir, entry.name, 'yg-flow.yaml');
    const flow = await parseFlow(path.join(flowsDir, entry.name), flowYamlPath);
    flows.push(flow);
  }
  return flows;
}

async function loadSchemas(schemasDir: string): Promise<SchemaDef[]> {
  try {
    const entries = (await readdir(schemasDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const schemas: SchemaDef[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const s = await parseSchema(path.join(schemasDir, entry.name));
      schemas.push(s);
    }
    return schemas;
  } catch {
    return [];
  }
}

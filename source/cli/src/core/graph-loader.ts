import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  Graph,
  GraphNode,
  AspectDef,
  FlowDef,
  SchemaDef,
  YggConfig,
} from '../model/types.js';
import { parseConfig } from '../io/config-parser.js';
import { parseNodeYaml } from '../io/node-parser.js';
import { parseAspect } from '../io/aspect-parser.js';
import { parseFlow } from '../io/flow-parser.js';
import { parseSchema } from '../io/schema-parser.js';
import { readArtifacts } from '../io/artifact-reader.js';
import { findYggRoot } from '../utils/paths.js';

function toModelPath(absolutePath: string, modelDir: string): string {
  return path.relative(modelDir, absolutePath).split(path.sep).join('/');
}

const FALLBACK_CONFIG: YggConfig = {
  name: '',
  stack: {},
  standards: '',
  node_types: [],
  artifacts: {},
};

export async function loadGraph(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean } = {},
): Promise<Graph> {
  const yggRoot = await findYggRoot(projectRoot);
  let configError: string | undefined;
  let config = FALLBACK_CONFIG;
  try {
    config = await parseConfig(path.join(yggRoot, 'config.yaml'));
  } catch (error) {
    if (!options.tolerateInvalidConfig) {
      throw error;
    }
    configError = (error as Error).message;
  }

  const modelDir = path.join(yggRoot, 'model');
  const nodes = new Map<string, GraphNode>();
  const nodeParseErrors: Array<{ nodePath: string; message: string }> = [];
  const artifactFilenames = Object.keys(config.artifacts ?? {});
  try {
    await scanModelDirectory(modelDir, modelDir, null, nodes, nodeParseErrors, artifactFilenames);
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
    configError,
    nodeParseErrors: nodeParseErrors.length > 0 ? nodeParseErrors : undefined,
    nodes,
    aspects,
    flows,
    schemas,
    rootPath: yggRoot,
  };
}

async function scanModelDirectory(
  dirPath: string,
  modelDir: string,
  parent: GraphNode | null,
  nodes: Map<string, GraphNode>,
  nodeParseErrors: Array<{ nodePath: string; message: string }>,
  artifactFilenames: string[],
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'node.yaml');

  if (!hasNodeYaml && dirPath !== modelDir) {
    return;
  }

  if (hasNodeYaml) {
    const graphPath = toModelPath(dirPath, modelDir);
    let meta;
    try {
      meta = await parseNodeYaml(path.join(dirPath, 'node.yaml'));
    } catch (err) {
      nodeParseErrors.push({
        nodePath: graphPath,
        message: (err as Error).message,
      });
      return;
    }
    const artifacts = await readArtifacts(dirPath, ['node.yaml'], artifactFilenames);

    const node: GraphNode = {
      path: graphPath,
      meta,
      artifacts,
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
        artifactFilenames,
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
        artifactFilenames,
      );
    }
  }
}

async function loadAspects(aspectsDir: string): Promise<AspectDef[]> {
  try {
    const entries = await readdir(aspectsDir, { withFileTypes: true });
    const aspects: AspectDef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const aspectYamlPath = path.join(aspectsDir, entry.name, 'aspect.yaml');
      const aspect = await parseAspect(
        path.join(aspectsDir, entry.name),
        aspectYamlPath,
        entry.name,
      );
      aspects.push(aspect);
    }
    return aspects;
  } catch {
    return [];
  }
}

async function loadFlows(flowsDir: string): Promise<FlowDef[]> {
  try {
    const entries = await readdir(flowsDir, { withFileTypes: true });
    const flows: FlowDef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const flowYamlPath = path.join(flowsDir, entry.name, 'flow.yaml');
      const flow = await parseFlow(path.join(flowsDir, entry.name), flowYamlPath);
      flows.push(flow);
    }
    return flows;
  } catch {
    return [];
  }
}

async function loadSchemas(schemasDir: string): Promise<SchemaDef[]> {
  try {
    const entries = await readdir(schemasDir, { withFileTypes: true });
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

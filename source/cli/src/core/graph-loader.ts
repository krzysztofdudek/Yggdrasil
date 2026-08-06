import path from 'node:path';
import { readSortedDir, readSortedDirOrEmpty, readTextFile } from '../io/graph-fs.js';
import { gt, lt, valid } from 'semver';
import type {
  Graph,
  GraphNode,
  AspectDef,
  FlowDef,
  YggConfig,
  ArchitectureDef,
} from '../model/graph.js';
import { parseConfig, ConfigParseError } from '../io/config-parser.js';
import { parseNodeYaml } from '../io/node-parser.js';
import { parseAspect } from '../io/aspect-parser.js';
import { parseFlow } from '../io/flow-parser.js';
import { parseArchitecture } from '../io/architecture-parser.js';
import { WhenPredicateInvalidError } from '../utils/file-when-parser.js';
import type { ArchitectureLoadError } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { findYggRoot } from '../io/paths.js';
import { detectVersion } from './migrator.js';
import { toPosixPath } from '../utils/posix.js';

export const CLI_SUPPORTED_SCHEMA = '5.2.0';

/**
 * Thrown when the project's yg-config.yaml declares a schema version newer than
 * this CLI can read. This is an expected USER condition (the user must upgrade
 * their CLI), NOT an internal bug — callers recognize it and emit a clean
 * what/why/next message instead of the generic "please file an issue" wrapper.
 */
export class UnsupportedSchemaVersionError extends Error {
  readonly detectedVersion: string;
  readonly maxSupportedVersion: string;

  constructor(detectedVersion: string, maxSupportedVersion: string) {
    super(
      `yg-config.yaml version "${detectedVersion}" is newer than this CLI supports ` +
        `(max: ${maxSupportedVersion}).`,
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.detectedVersion = detectedVersion;
    this.maxSupportedVersion = maxSupportedVersion;
  }
}

/**
 * Thrown when the project's yg-config.yaml declares a schema version older than
 * this CLI supports. The graph must be migrated before it can be read.
 * This is an expected USER condition (the user must run `yg init --upgrade`),
 * NOT an internal bug — callers recognize it and emit a clean what/why/next
 * message instead of the generic "please file an issue" wrapper.
 */
export class OutdatedSchemaVersionError extends Error {
  readonly detectedVersion: string;
  readonly minSupportedVersion: string;

  constructor(detectedVersion: string, minSupportedVersion: string) {
    super(
      `the .yggdrasil graph is at version ${detectedVersion}, older than this CLI (${minSupportedVersion}). ` +
        `Run \`yg init --upgrade\` to migrate the graph, then re-run.`,
    );
    this.name = 'OutdatedSchemaVersionError';
    this.detectedVersion = detectedVersion;
    this.minSupportedVersion = minSupportedVersion;
  }
}

/**
 * Thrown when the project's yg-config.yaml declares a `version:` field that is
 * present but not valid semver (e.g. "5.1" or "latest"). Without a parseable
 * version the CLI cannot tell whether the graph is newer, older, or current, so
 * the version gate cannot be evaluated — reading the graph anyway would fail
 * OPEN (a clean PASS over a graph whose format the CLI never confirmed it can
 * read). This is an expected USER condition (a hand-edited or corrupted version
 * field), NOT an internal bug — callers recognize it and emit a clean
 * what/why/next message instead of the generic "please file an issue" wrapper.
 */
export class MalformedSchemaVersionError extends Error {
  readonly detectedVersion: string;

  constructor(detectedVersion: string) {
    super(
      `yg-config.yaml version "${detectedVersion}" is not valid semver, so the CLI ` +
        `cannot determine graph compatibility. Restore the version field from version ` +
        `control or re-run \`yg init\`.`,
    );
    this.name = 'MalformedSchemaVersionError';
    this.detectedVersion = detectedVersion;
  }
}

/**
 * Thrown when a `flows/<x>/yg-flow.yaml` cannot be loaded — the file is missing
 * (ENOENT), is a directory (EISDIR), is unparseable YAML, or fails flow-shape
 * validation. This is an expected USER condition on an ALREADY-INITIALIZED graph
 * (the fault is one flow file, not a missing `.yggdrasil/`), NOT an internal bug:
 * callers recognize it and emit a flow-specific what/why/next message instead of
 * the misleading "run yg init" (ENOENT) or "please file an issue" (YAML/EISDIR)
 * wrappers. `flowYamlPath` names the offending file; `detail` carries the
 * underlying reason (e.g. the parser's shape message or the raw fs error text).
 */
export class FlowLoadError extends Error {
  readonly flowYamlPath: string;
  readonly detail: string;

  constructor(flowYamlPath: string, cause: unknown) {
    // Normalize to POSIX separators: this path is surfaced verbatim in CLI-facing
    // what/why/next output, so an OS-native (backslash) path here would leak into
    // stdout/stderr. Normalizing at the single construction point covers both the
    // stored property and the embedded message.
    const normalizedPath = toPosixPath(flowYamlPath);
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load flow file ${normalizedPath}: ${detail}`);
    this.name = 'FlowLoadError';
    this.flowYamlPath = normalizedPath;
    this.detail = detail;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function toModelPath(absolutePath: string, modelDir: string): string {
  return toPosixPath(path.relative(modelDir, absolutePath));
}

const FALLBACK_CONFIG: YggConfig = {};

export async function loadGraph(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean; noSecrets?: boolean } = {},
): Promise<Graph> {
  const yggRoot = await findYggRoot(projectRoot);

  const detected = await detectVersion(yggRoot);
  // A present-but-unparseable version fails CLOSED. valid() short-circuits both
  // gt/lt gates below, so without this branch a malformed version ("5.1",
  // "latest") would slip past the gate entirely and let the graph load as if it
  // were the current schema.
  if (detected !== null && valid(detected) === null) {
    throw new MalformedSchemaVersionError(detected);
  }
  if (detected !== null && valid(detected) && gt(detected, CLI_SUPPORTED_SCHEMA)) {
    throw new UnsupportedSchemaVersionError(detected, CLI_SUPPORTED_SCHEMA);
  }
  if (detected !== null && valid(detected) && lt(detected, CLI_SUPPORTED_SCHEMA)) {
    throw new OutdatedSchemaVersionError(detected, CLI_SUPPORTED_SCHEMA);
  }

  let configError: string | undefined;
  let configErrorCode: string | undefined;
  let configErrorMessage: IssueMessage | undefined;
  let config = FALLBACK_CONFIG;
  try {
    // noSecrets threads the committed-only read down to the config parser: when set,
    // yg-secrets.yaml is never opened or merged. Default (unset) is unchanged.
    config = await parseConfig(path.join(yggRoot, 'yg-config.yaml'), { skipSecretsOverlay: options.noSecrets });
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // Structured config error — always capture (never rethrow), propagate structured message
      configErrorMessage = error.messageData;
      configErrorCode = error.code;
      configError = error.messageData.what;
    } else if (!options.tolerateInvalidConfig) {
      throw error;
    } else {
      configError = (error as Error).message;
    }
  }

  const { architecture, error: architectureError } = await loadArchitecture(yggRoot);

  const modelDir = path.join(yggRoot, 'model');
  const nodes = new Map<string, GraphNode>();
  const nodeParseErrors: Array<{ nodePath: string; messageData: IssueMessage }> = [];
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

  const aspectsLoad = await loadAspects(path.join(yggRoot, 'aspects'));
  const flows = await loadFlows(path.join(yggRoot, 'flows'));

  return {
    config,
    architecture,
    architectureError,
    configError,
    configErrorCode,
    configErrorMessage,
    nodeParseErrors: nodeParseErrors.length > 0 ? nodeParseErrors : undefined,
    aspectParseErrors: aspectsLoad.parseErrors.length > 0 ? aspectsLoad.parseErrors : undefined,
    nodes,
    aspects: aspectsLoad.aspects,
    flows,
    rootPath: toPosixPath(yggRoot),
  };
}

async function loadArchitecture(
  yggRoot: string,
): Promise<{ architecture: ArchitectureDef; error?: ArchitectureLoadError }> {
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
    if (error instanceof WhenPredicateInvalidError) {
      const whenMsg: IssueMessage = {
        what: error.message,
        why: 'The when: predicate in yg-architecture.yaml could not be parsed. Architecture cannot be loaded until this is fixed.',
        next: 'Fix the when: predicate syntax in yg-architecture.yaml. Run yg schemas read architecture for the allowed shape.',
      };
      return {
        architecture: emptyArch,
        error: { code: 'when-predicate-invalid', messageData: whenMsg },
      };
    }
    const msg = (error as Error).message;
    const archInvalidMsg: IssueMessage = {
      what: msg,
      why: `yg-architecture.yaml failed to parse. No architecture-level rules can be checked until this is fixed.`,
      next: `Fix the YAML syntax in yg-architecture.yaml. Run yg check again to verify.`,
    };
    return { architecture: emptyArch, error: { code: 'architecture-invalid', messageData: archInvalidMsg } };
  }
}

async function scanModelDirectory(
  dirPath: string,
  modelDir: string,
  parent: GraphNode | null,
  nodes: Map<string, GraphNode>,
  nodeParseErrors: Array<{ nodePath: string; messageData: IssueMessage }>,
): Promise<void> {
  const entries = await readSortedDir(dirPath);
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
      nodeYamlRaw = await readTextFile(nodeYamlPath);
      meta = await parseNodeYaml(nodeYamlPath);
    } catch (err) {
      nodeParseErrors.push({
        nodePath: graphPath,
        messageData: {
          what: `yg-node.yaml parse error in ${graphPath}.`,
          why: (err as Error).message,
          next: `Fix the YAML in .yggdrasil/model/${graphPath}/yg-node.yaml.`,
        },
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

async function loadAspects(
  aspectsDir: string,
): Promise<{ aspects: AspectDef[]; parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> }> {
  const aspects: AspectDef[] = [];
  const parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> = [];
  try {
    await scanAspectsDirectory(aspectsDir, aspectsDir, aspects, parseErrors);
  } catch (err) {
    // Only a filesystem "no usable aspects/ directory" condition is benign
    // empty-state: the directory is absent (ENOENT) or the path is not a
    // directory at all (ENOTDIR). Any OTHER error — a parse throw that escaped
    // parseAspect's {ok:false} contract, or an I/O fault — must NOT be silently
    // swallowed: doing so drops every aspect and lets yg check report a clean
    // PASS over unenforced code. Re-throw so the loader surfaces it.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
  }
  return { aspects, parseErrors };
}

async function scanAspectsDirectory(
  dirPath: string,
  aspectsRoot: string,
  aspects: AspectDef[],
  parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }>,
): Promise<void> {
  const entries = await readSortedDir(dirPath);
  const hasAspectYaml = entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml');

  if (hasAspectYaml) {
    const id = toPosixPath(path.relative(aspectsRoot, dirPath));
    const aspectYamlPath = path.join(dirPath, 'yg-aspect.yaml');
    const result = await parseAspect(dirPath, aspectYamlPath, id);
    if (result.ok) {
      aspects.push(result.aspect);
    } else {
      for (const err of result.errors) {
        parseErrors.push({ aspectId: result.aspectId, code: err.code, messageData: err.messageData });
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    // A directory named `drills` holds an aspect's hand-authored regression
    // fixtures (synthetic sources run manually via `yg aspect-test`), NOT nested
    // aspects. Hard-skip it so a fixture that happens to contain a `yg-aspect.yaml`
    // — or any file the parser could mistake for one — can never register a
    // phantom aspect. `drills` is a reserved directory name inside an aspect dir.
    if (entry.name === 'drills') continue;
    await scanAspectsDirectory(path.join(dirPath, entry.name), aspectsRoot, aspects, parseErrors);
  }
}

async function loadFlows(flowsDir: string): Promise<FlowDef[]> {
  const entries = await readSortedDirOrEmpty(flowsDir);
  if (entries.length === 0) return [];
  const flows: FlowDef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flowYamlPath = path.join(flowsDir, entry.name, 'yg-flow.yaml');
    let flow: FlowDef;
    try {
      flow = await parseFlow(path.join(flowsDir, entry.name), flowYamlPath);
    } catch (err) {
      // The graph IS initialized — a flow file that is missing (ENOENT), is a
      // directory (EISDIR), is unparseable YAML, or fails shape validation must
      // NOT surface as "no .yggdrasil/" or an unclassified "file an issue" bug.
      // Tag it with the offending file so the preamble renders a flow-specific
      // what/why/next.
      throw new FlowLoadError(flowYamlPath, err);
    }
    flows.push(flow);
  }
  return flows;
}


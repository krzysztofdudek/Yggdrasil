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
import { parsePackageManifest } from '../io/package-manifest-parser.js';
import { isIgnoredPackageEntry } from '../io/package-store.js';
import { PACKAGE_FILENAME, PACKAGES_DIR } from '../model/packages.js';
import { parseFlow } from '../io/flow-parser.js';
import { parseArchitecture } from '../io/architecture-parser.js';
import { WhenPredicateInvalidError } from '../utils/file-when-parser.js';
import type { ArchitectureLoadError } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { findYggRoot } from '../io/paths.js';
import { readSchemaVersion } from './migrator.js';
import { toPosixPath } from '../utils/posix.js';

export const CLI_SUPPORTED_SCHEMA = '6.0.0';

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
  /**
   * True when the field is not a YAML string at all — typically an unquoted
   * `version: 5.1`, which YAML reads as a number. The fix differs (quote it),
   * so callers word their message on it.
   */
  readonly notAString: boolean;

  constructor(detectedVersion: string, opts: { notAString?: boolean } = {}) {
    super(
      opts.notAString
        ? `yg-config.yaml version ${detectedVersion} is not a string (an unquoted YAML number), so the CLI ` +
            `cannot determine graph compatibility. Write it as a quoted semver string, e.g. version: "6.0.0".`
        : `yg-config.yaml version "${detectedVersion}" is not valid semver, so the CLI ` +
            `cannot determine graph compatibility. Restore the version field from version ` +
            `control or re-run \`yg init\`.`,
    );
    this.name = 'MalformedSchemaVersionError';
    this.detectedVersion = detectedVersion;
    this.notAString = opts.notAString === true;
  }
}

/**
 * Thrown when yg-config.yaml exists but has no `version:` field. The field is
 * what tells the CLI which graph schema it is reading; loading without it would
 * fail OPEN exactly like a malformed version would. An expected USER condition
 * (a deleted or never-written line), rendered as a clean what/why/next.
 */
export class MissingSchemaVersionError extends Error {
  constructor() {
    super('yg-config.yaml has no version: field, so the CLI cannot determine graph compatibility.');
    this.name = 'MissingSchemaVersionError';
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

  const versionRead = await readSchemaVersion(yggRoot);
  // An absent or non-string version fails CLOSED, like a malformed one: every
  // gate below needs a version to compare, so "no usable version" must never
  // mean "load as the current schema". A null read (no readable config at all)
  // is left to the config parser, which reports that file itself.
  if (versionRead?.kind === 'absent') {
    throw new MissingSchemaVersionError();
  }
  if (versionRead?.kind === 'not-string') {
    throw new MalformedSchemaVersionError(versionRead.shown, { notAString: true });
  }
  const detected = versionRead?.kind === 'string' ? versionRead.value : null;
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
    // An absent model/ is an empty graph, not an uninitialized one. Git does not
    // track empty directories, so a graph committed before its first node comes
    // back from a clone without model/ at all; the graph root and its config are
    // there, and every command must work on it exactly as it did before the commit.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT' || e.path !== modelDir) throw err;
  }

  const aspectsLoad = await loadAspects(path.join(yggRoot, 'aspects'), path.dirname(yggRoot));
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
    // A YAML syntax error and a schema violation (an unknown key, a missing
    // description) are different faults with different fixes; calling the second
    // a "YAML syntax" problem sends the reader hunting for an indentation error
    // in a file that parses fine.
    const isSyntaxError = (error as Error).name === 'YAMLParseError';
    const archInvalidMsg: IssueMessage = isSyntaxError
      ? {
          what: msg,
          why: `yg-architecture.yaml failed to parse. No architecture-level rules can be checked until this is fixed.`,
          next: `Fix the YAML syntax in yg-architecture.yaml. Run yg check again to verify.`,
        }
      : {
          what: msg,
          why: `yg-architecture.yaml is valid YAML, but its content breaks the architecture schema, so it was not loaded. No architecture-level rules can be checked until this is fixed.`,
          next: `Correct what the message above names in yg-architecture.yaml (yg schemas read architecture lists the allowed shape), then run yg check again.`,
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
      // The parser's own message is WHAT happened (its first line, then any
      // excerpt it quotes); WHY says what not loading the component costs —
      // every finding that names it downstream is a symptom of this one.
      const isSyntaxError = (err as Error).name === 'YAMLParseError';
      const [reason, ...excerpt] = (err as Error).message.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
      nodeParseErrors.push({
        nodePath: graphPath,
        messageData: {
          what: [`yg-node.yaml in ${graphPath} ${isSyntaxError ? 'does not parse' : 'breaks the node schema'}: ${reason ?? 'unknown error'}`, ...excerpt].join('\n'),
          why: isSyntaxError
            ? `The file is not valid YAML, so component '${graphPath}' was not loaded: a flow or relation naming it reads it as missing, and the files it maps read as unmapped, until it parses.`
            : `The file is valid YAML but does not match the node schema, so component '${graphPath}' was not loaded: a flow or relation naming it reads it as missing, and the files it maps read as unmapped, until it is corrected.`,
          next: isSyntaxError
            ? `Fix the YAML in .yggdrasil/model/${graphPath}/yg-node.yaml.`
            : `Correct what the reason above names in .yggdrasil/model/${graphPath}/yg-node.yaml (yg schemas read node lists the allowed fields).`,
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

    // Dot-named directories are walked like any other: mirroring source paths
    // under model/ puts CI and editor-config rules in model/.github/ and
    // model/.vscode/, and skipping them dropped those nodes — and every enforced
    // rule they attach — without a word. A directory without yg-node.yaml still
    // stops the walk (the check above), so a stray hidden folder loads nothing.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

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
  projectRoot: string,
): Promise<{ aspects: AspectDef[]; parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> }> {
  const aspects: AspectDef[] = [];
  const parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> = [];
  try {
    await scanAspectsDirectory(aspectsDir, aspectsDir, aspects, parseErrors);
    // Installed packages are scanned separately, because a rule that arrived
    // inside one is read differently: its ids and its implies are relative to the
    // package, and its configuration comes from the package's own manifest. The
    // general walker above skips the `packages` directory entirely, so a
    // repository with no packages takes byte-identical paths through this loader.
    await scanInstalledPackages(aspectsDir, projectRoot, aspects, parseErrors);
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
    // `packages` directly under aspects/ is where installed packages live. It is
    // NOT a nesting of ordinary aspect directories — every rule under it is read
    // with its package's manifest in hand — so the general walk stops here and
    // scanInstalledPackages takes over. Reserved at the aspects root only: a
    // `packages` directory deeper inside someone's own aspect tree is untouched.
    if (dirPath === aspectsRoot && entry.name === PACKAGES_DIR) continue;
    // A directory named `drills` holds an aspect's hand-authored regression
    // fixtures (synthetic sources run manually via `yg aspect-test`), NOT nested
    // aspects. Hard-skip it so a fixture that happens to contain a `yg-aspect.yaml`
    // — or any file the parser could mistake for one — can never register a
    // phantom aspect. `drills` is a reserved directory name inside an aspect dir.
    if (entry.name === 'drills') continue;
    await scanAspectsDirectory(path.join(dirPath, entry.name), aspectsRoot, aspects, parseErrors);
  }
}

/** Why a directory under `aspects/packages/` that is not an installed package loads nothing. */
function packagesReservedMessage(dirId: string): IssueMessage {
  return {
    what: `.yggdrasil/aspects/${dirId} is not an installed package, and ${PACKAGES_DIR}/ under .yggdrasil/aspects/ holds nothing else — nothing in it was loaded.`,
    why: `Since 6.0.0 the directory .yggdrasil/aspects/${PACKAGES_DIR}/ is reserved for packages installed with yg pack, laid out as <owner>/<repo>/<package>/ with a ${PACKAGE_FILENAME} in each. A rule of this repository's own placed there is never read, so everything that attaches it reports it as undefined.`,
    next: `Move your own rule to a directory under .yggdrasil/aspects/ outside ${PACKAGES_DIR}/ and update the ids that attach it; if this was an installed package, install it again with yg pack add.`,
  };
}

/**
 * Load every rule installed from a package.
 *
 * The layout under `aspects/packages/` is fixed at three levels — owner, repo,
 * package — because that is what gives a package an identity nobody else can
 * claim: two forks of the same marketplace install side by side, and neither can
 * shadow the other's rules. Each package directory is read with its own manifest
 * in hand, so its rules get their install prefix, their relative implies resolved,
 * and their configuration defaults.
 *
 * A malformed package produces ONE parse error against the package's own id and
 * contributes no rules, rather than aborting the load: a graph that refuses to
 * open is a graph nobody can run `yg pack remove` against.
 */
async function scanInstalledPackages(
  aspectsDir: string,
  projectRoot: string,
  aspects: AspectDef[],
  parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }>,
): Promise<void> {
  const packagesRoot = path.join(aspectsDir, PACKAGES_DIR);
  const owners = await readSortedDirOrEmpty(packagesRoot);
  // A rule of this repository's own sitting where only installed packages may
  // live is not loaded — and saying only "undefined" wherever it is attached
  // would hide why. Every level of the fixed layout that holds a rule
  // definition of its own is named as the reserved directory it is.
  const reserved = (dirId: string, entries: Array<{ name: string; isFile(): boolean }>): void => {
    if (!entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) return;
    parseErrors.push({ aspectId: dirId, code: 'aspect-packages-dir-reserved', messageData: packagesReservedMessage(dirId) });
  };
  reserved(PACKAGES_DIR, owners);
  for (const owner of owners) {
    if (!owner.isDirectory() || owner.name.startsWith('.')) continue;
    const repos = await readSortedDirOrEmpty(path.join(packagesRoot, owner.name));
    reserved(`${PACKAGES_DIR}/${owner.name}`, repos);
    for (const repo of repos) {
      if (!repo.isDirectory() || repo.name.startsWith('.')) continue;
      const packages = await readSortedDirOrEmpty(path.join(packagesRoot, owner.name, repo.name));
      reserved(`${PACKAGES_DIR}/${owner.name}/${repo.name}`, packages);
      for (const pkgDir of packages) {
        if (!pkgDir.isDirectory() || pkgDir.name.startsWith('.')) continue;
        const installId = `${owner.name}/${repo.name}/${pkgDir.name}`;
        const idPrefix = `${PACKAGES_DIR}/${installId}`;
        const packageRootAbs = path.join(packagesRoot, owner.name, repo.name, pkgDir.name);
        const manifestPath = path.join(packageRootAbs, PACKAGE_FILENAME);

        const presentDirs = (await readSortedDirOrEmpty(packageRootAbs))
          .filter((e) => e.isDirectory() && !isIgnoredPackageEntry(e.name))
          .map((e) => e.name);

        const manifestResult = await parsePackageManifest(manifestPath, presentDirs);
        if (!manifestResult.ok) {
          for (const err of manifestResult.errors) {
            // No manifest at all is not a broken package but a directory that
            // was never one — most often a rule of the repository's own, from
            // before packages/ was reserved.
            parseErrors.push(
              err.code === 'package-manifest-missing'
                ? { aspectId: idPrefix, code: 'aspect-packages-dir-reserved', messageData: packagesReservedMessage(idPrefix) }
                : { aspectId: idPrefix, code: err.code, messageData: err.messageData },
            );
          }
          continue;
        }
        const manifest = manifestResult.value;

        for (const aspectDirName of manifest.aspects) {
          const aspectDir = path.join(packageRootAbs, aspectDirName);
          const aspectYamlPath = path.join(aspectDir, 'yg-aspect.yaml');
          const id = `${idPrefix}/${aspectDirName}`;
          const result = await parseAspect(aspectDir, aspectYamlPath, id, {
            projectRoot,
            package: {
              packageName: manifest.name,
              idPrefix,
              aspectDirs: manifest.aspects,
              relativeId: aspectDirName,
              configSchema: manifest.config?.[aspectDirName] ?? {},
            },
          });
          if (result.ok) {
            aspects.push(result.aspect);
          } else {
            for (const err of result.errors) {
              parseErrors.push({ aspectId: result.aspectId, code: err.code, messageData: err.messageData });
            }
          }
        }
      }
    }
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


/**
 * A graph that cannot be loaded, diagnosed as the what/why/next an adopter acts
 * on. Thrown by {@link loadGraphOrThrow}; the CLI prints `issue` and exits, and a
 * long-lived caller (the portal server) turns it into an error response and keeps
 * running — an ordinary edit (a half-written flow file, a branch switch, an
 * upgrade in progress) must never end the process that is watching the graph.
 */
export class GraphLoadError extends Error {
  readonly issue: IssueMessage;
  constructor(issue: IssueMessage, cause: unknown) {
    super(`${issue.what}\n${issue.why}\n${issue.next}`);
    this.name = 'GraphLoadError';
    this.issue = issue;
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * The what/why/next for a yg-config.yaml whose `version:` field is unusable —
 * absent, or present but not a string (an unquoted `version: 5.1` is a YAML
 * number). Shared by the graph load path and `yg init --upgrade`, which refuse
 * the same two cases and must say the same thing about them.
 */
export function schemaVersionFieldIssue(
  problem: { kind: 'absent' } | { kind: 'not-string'; shown: string },
): IssueMessage {
  if (problem.kind === 'absent') {
    return {
      what: '.yggdrasil/yg-config.yaml has no version: field.',
      why: 'The version field records which graph schema this graph was written for. Without it the CLI cannot tell whether it can read the graph, cannot choose migrations, and reading the graph anyway would pass over a format it never confirmed it can read.',
      next: `Restore the field from version control. If you know this graph was written for this CLI's schema, add version: "${CLI_SUPPORTED_SCHEMA}" to .yggdrasil/yg-config.yaml. Then re-run.`,
    };
  }
  return {
    what: `.yggdrasil/yg-config.yaml has version: ${problem.shown}, which YAML reads as a number, not a version string.`,
    why: 'The schema version must be a full semver string such as "6.0.0". A bare number cannot be compared against the schema this CLI reads, and reading the graph anyway would pass over a format it never confirmed it can read.',
    next: `Write the version as a quoted three-part string, e.g. version: "${CLI_SUPPORTED_SCHEMA}". Restore it from version control if you are unsure which schema the graph was written for. Then re-run.`,
  };
}

/**
 * Classify a `loadGraph` failure the adopter can fix into its what/why/next, or
 * undefined for anything else (an unclassified error stays a bug and is
 * rethrown as-is by the caller).
 */
export function diagnoseGraphLoadError(err: unknown): IssueMessage | undefined {
  if (err instanceof UnsupportedSchemaVersionError) {
    return {
      what: `Graph schema version ${err.detectedVersion} is newer than this CLI supports (max: ${err.maxSupportedVersion}).`,
      why: 'This CLI cannot safely read a graph written for a newer schema — it may misinterpret or skip fields it does not understand.',
      next: `Upgrade the yg CLI to a version that supports schema ${err.detectedVersion} (e.g. \`npm i -g @chrisdudek/yg\`), then re-run this command.`,
    };
  }
  if (err instanceof OutdatedSchemaVersionError) {
    return {
      what: `the .yggdrasil graph is at version ${err.detectedVersion}, older than this CLI (${err.minSupportedVersion}).`,
      why: `${err.minSupportedVersion} reads only the current on-disk format; older formats are upgraded by a migration, not parsed directly.`,
      next: `run \`yg init --upgrade\` to migrate the graph to ${err.minSupportedVersion}, then re-run.`,
    };
  }
  if (err instanceof MissingSchemaVersionError) {
    return schemaVersionFieldIssue({ kind: 'absent' });
  }
  if (err instanceof MalformedSchemaVersionError && err.notAString) {
    return schemaVersionFieldIssue({ kind: 'not-string', shown: err.detectedVersion });
  }
  if (err instanceof MalformedSchemaVersionError) {
    return {
      what: `yg-config.yaml version "${err.detectedVersion}" is not valid semver.`,
      why: 'The CLI cannot determine graph compatibility without a parseable version — reading the graph anyway could pass over a format it never confirmed it can read.',
      next: 'Restore the version field in .yggdrasil/yg-config.yaml from version control, or re-run `yg init`, then re-run this command.',
    };
  }
  // A flow file that is missing / a directory / unparseable / mis-shaped is a
  // fault in ONE flow file on an ALREADY-INITIALIZED graph — never "run yg init"
  // and never an unclassified "file an issue" bug. Classified BEFORE the
  // graph-root ENOENT branch (an absent yg-flow.yaml is ENOENT, but the graph exists).
  if (err instanceof FlowLoadError) {
    return {
      what: `Flow file ${err.flowYamlPath} could not be loaded: ${err.detail}`,
      why: 'The graph is initialized, but this flow file is missing, unreadable, or malformed — the graph cannot load until every flow file under .yggdrasil/flows/ is a valid yg-flow.yaml.',
      next: 'Fix the flow file (a valid yg-flow.yaml with a name and a non-empty nodes list), or remove its directory under .yggdrasil/flows/ if the flow is no longer needed.',
    };
  }
  const msg = (err as Error | undefined)?.message ?? '';
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // Only the graph-root/.yggdrasil probe means "not initialized". `findYggRoot`
  // converts a genuinely-missing graph into the descriptive message matched
  // below (an absent model/ is an empty graph, not a missing one); a RAW ENOENT
  // is limited to the `.yggdrasil` probe itself (matched by path basename) so a
  // downstream stray ENOENT never masquerades as "run yg init".
  const enoentPath = (err as NodeJS.ErrnoException | undefined)?.path;
  const isGraphRootProbe = code === 'ENOENT' && typeof enoentPath === 'string' && path.basename(enoentPath) === '.yggdrasil';
  if (isGraphRootProbe || msg.includes('No .yggdrasil/ directory found')) {
    return {
      what: 'No .yggdrasil/ directory found in the current project.',
      why: 'Yggdrasil commands require an initialized graph at the project root.',
      next: "Run 'yg init' to bootstrap the graph, then re-run this command.",
    };
  }
  return undefined;
}

/**
 * {@link loadGraph}, with every failure an adopter can fix thrown as a
 * {@link GraphLoadError}. Never exits: the CLI's `loadGraphOrAbort` wraps this
 * and exits, and the portal server lets it fail one request.
 */
export async function loadGraphOrThrow(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean; noSecrets?: boolean } = {},
): Promise<Graph> {
  try {
    return await loadGraph(projectRoot, options);
  } catch (err) {
    const issue = diagnoseGraphLoadError(err);
    if (issue !== undefined) throw new GraphLoadError(issue, err);
    throw err;
  }
}

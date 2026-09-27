/**
 * The three `yg impact` targets answered from a graph object rather than a
 * file: a rule (--aspect), a flow (--flow) and a type (--type). Each refuses a
 * target the graph does not hold, asks the engine for the facts
 * (core/impact-cost.ts) and prints them as the formatter words them
 * (formatters/impact-text.ts). Nothing is computed or worded here.
 */
import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import {
  aspectImpactOf,
  computeTypeVerdictImpact,
  flowImpactOf,
  nodesOfType,
  strictCoverageGapOf,
  typeCoveredFilesOf,
} from '../core/impact-cost.js';
import {
  renderAspectImpact,
  renderFlowImpact,
  renderStrictCoverageGap,
  renderTypeCoveredFiles,
  renderTypeHeader,
  renderTypeNext,
  renderTypeVerdictImpact,
} from '../formatters/impact-text.js';
import { aspectNotFound, writeOut, failAndExit } from './output.js';

export async function handleAspectImpact(
  graph: Graph,
  aspectId: string,
  lock: LockFile,
  projectRoot: string,
): Promise<void> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    failAndExit(aspectNotFound(aspectId, 'Impact is measured from a rule, so the rule must exist in the graph.'), 'aspect-not-found');
  }
  writeOut(renderAspectImpact(await aspectImpactOf(graph, aspect, lock, projectRoot)));
}

export async function handleFlowImpact(
  graph: Graph,
  flowName: string,
): Promise<void> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) {
    failAndExit({
      what: `Flow not found: ${flowName}`,
      why: 'The flow name must match a directory name under .yggdrasil/flows/.',
      next: 'Run: yg flows — to list all defined flows.',
    }, 'command-error');
  }
  writeOut(renderFlowImpact(flowImpactOf(graph, flow)));
}

export async function handleTypeImpact(graph: Graph, typeId: string, lock: LockFile): Promise<void> {
  // Own-key check before indexing: a raw bracket lookup would resolve inherited
  // Object.prototype members (constructor, toString, valueOf, hasOwnProperty),
  // fabricating a zero-impact report for a type that does not exist.
  if (!Object.keys(graph.architecture.node_types).includes(typeId)) {
    failAndExit({
      what: `Type '${typeId}' not found in architecture.`,
      why: 'The type id must match a node_types key in .yggdrasil/yg-architecture.yaml.',
      next: 'Read .yggdrasil/yg-architecture.yaml to see defined types.',
    }, 'command-error');
  }
  const def = graph.architecture.node_types[typeId];

  // Each part is printed as soon as it is known, so a slow scan further down
  // never holds back what is already answered.
  const typeNodes = nodesOfType(graph, typeId);
  writeOut(renderTypeHeader(typeId, def, typeNodes));

  const { files, typeCoveredPaths, typeCoverage } = await typeCoveredFilesOf(graph, typeId, typeNodes);
  writeOut(renderTypeCoveredFiles(files));

  if (typeCoveredPaths.length > 0) {
    writeOut(renderTypeVerdictImpact(await computeTypeVerdictImpact(graph, typeId, typeCoverage!, lock)));
  }

  if (def.enforce === 'strict' && def.when) {
    writeOut(renderStrictCoverageGap(typeId, await strictCoverageGapOf(graph, typeId, def.when)));
  }
  writeOut(renderTypeNext(typeCoveredPaths.length > 0));
}

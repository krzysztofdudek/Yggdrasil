import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { FileContentCache } from '../../io/file-content-cache.js';
import { evaluateFileWhen } from '../file-when-evaluator.js';
import { renderTrace } from '../../formatters/predicate-trace.js';
import { issueMsg } from './shared.js';
import { expandMappingPaths } from '../../io/hash.js';
import { isGlobPattern, mappingEntryMatchesFile } from '../../utils/mapping-path.js';
import { toPosixPath } from '../../utils/posix.js';
import { getChildMappingExclusions } from '../pairs.js';

export function checkTypeUnknownParent(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTypes = new Set(Object.keys(graph.architecture.node_types));
  for (const [typeName, typeConfig] of Object.entries(graph.architecture.node_types)) {
    for (const parent of typeConfig.parents ?? []) {
      if (!knownTypes.has(parent)) {
        const msgData: IssueMessage = {
          what: `Architecture type '${typeName}' declares parent '${parent}' which is not defined in node_types.`,
          why: `Parent types must be defined in yg-architecture.yaml — referencing an undefined type makes the architecture semantically invalid.`,
          next: `Add '${parent}' to node_types or remove it from '${typeName}.parents'.`,
        };
        issues.push({
          severity: 'error',
          code: 'type-unknown-parent',
          rule: 'type-unknown-parent',
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
    }
  }
  return issues;
}

/**
 * Every target-type name listed under `node_types.<type>.relations.<relType>`
 * must be a defined node type (or the `*` any-target wildcard). This is the
 * relation-side sibling of checkTypeUnknownParent: a typo in an allow-list
 * (`relations.calls: [widgett]`) is otherwise silent — a node of the intended
 * type never matches the misspelled entry, so the relation is over-restricted
 * (spurious relation-target-forbidden) or the constraint never fires as meant.
 * Catching the dangling name at the architecture level keeps the vocabulary
 * self-consistent before any node is judged against it.
 */
export function checkRelationTargetTypeUnknown(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTypes = new Set(Object.keys(graph.architecture.node_types));
  for (const [typeName, typeConfig] of Object.entries(graph.architecture.node_types)) {
    const lists = typeConfig.relations;
    if (!lists) continue;
    for (const [relType, targets] of Object.entries(lists)) {
      for (const target of targets ?? []) {
        if (target === '*' || knownTypes.has(target)) continue;
        const msgData: IssueMessage = {
          what: `Architecture type '${typeName}' allows relation '${relType}' to target type '${target}', which is not defined in node_types.`,
          why: `Relation target types must be defined in yg-architecture.yaml (or the '*' wildcard) — a dangling name silently over-restricts the relation, so a node of the intended type never matches it.`,
          next: `Fix the spelling, add '${target}' to node_types, use '*' for any target, or remove it from '${typeName}.relations.${relType}'.`,
        };
        issues.push({
          severity: 'error',
          code: 'relation-target-type-unknown',
          rule: 'relation-target-type-unknown',
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
    }
  }
  return issues;
}

export function checkArchitectureParentCycles(graph: Graph): ValidationIssue[] {
  const types = graph.architecture.node_types;
  const typeIds = Object.keys(types);

  // Skip if any parent reference is unknown — checkTypeUnknownParent handles that
  const knownTypes = new Set(typeIds);
  for (const def of Object.values(types)) {
    if (def.parents?.some((p) => !knownTypes.has(p))) return [];
  }

  // Pass 1: DFS three-color — collect back-edges (cycle-forming edges)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(typeIds.map((id) => [id, WHITE]));
  const backEdges = new Set<string>();
  const recordedCycles: string[][] = [];

  function dfs(typeId: string, path: string[]): void {
    if (color.get(typeId) === GRAY) {
      const cycleStart = path.indexOf(typeId);
      if (cycleStart !== -1) recordedCycles.push([...path.slice(cycleStart), typeId]);
      const from = path[path.length - 1];
      if (from !== undefined) backEdges.add(`${from}->${typeId}`);
      return;
    }
    if (color.get(typeId) === BLACK) return;
    color.set(typeId, GRAY);
    path.push(typeId);
    for (const parent of types[typeId]?.parents ?? []) dfs(parent, path);
    path.pop();
    color.set(typeId, BLACK);
  }
  for (const id of typeIds) { if (color.get(id) === WHITE) dfs(id, []); }

  // Pass 2: BFS per type excluding back-edges — check if rootable type reachable
  function isRootable(id: string): boolean {
    const parents = types[id]?.parents;
    return !parents || parents.length === 0;
  }
  function canReachRootable(typeId: string): boolean {
    if (isRootable(typeId)) return true;
    const visited = new Set<string>([typeId]);
    const queue: string[] = [typeId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const parent of types[cur]?.parents ?? []) {
        if (backEdges.has(`${cur}->${parent}`)) continue;
        if (isRootable(parent)) return true;
        if (!visited.has(parent)) { visited.add(parent); queue.push(parent); }
      }
    }
    return false;
  }

  const trapped = typeIds.filter((id) => !canReachRootable(id));
  if (trapped.length === 0) return [];

  const cycleStr = recordedCycles.length > 0
    ? recordedCycles[0].join(' → ')
    : trapped.join(' ↔ ');
  const msgData: IssueMessage = {
    what: `Cycle in parents: declarations:\n  ${cycleStr}\nTrapped types: ${trapped.join(', ')}`,
    why: `Every type in the cycle can only reach other cycle members — no rootable type is reachable. Nodes of these types can never be instantiated.`,
    next: `Break the cycle: add a rootable parent (one with no parents:), remove one parents: declaration, or add a third type as alternative parent.`,
  };
  return [{
    severity: 'error',
    code: 'architecture-cycle',
    rule: 'architecture-cycle',
    ...issueMsg(msgData),
    messageData: msgData,
  }];
}
export function checkEnforceStrictWithoutWhen(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [typeId, def] of Object.entries(graph.architecture.node_types)) {
    if (def.enforce === 'strict' && def.when === undefined) {
      const msgData: IssueMessage = {
        what: `Type '${typeId}' has enforce: strict but no when predicate.`,
        why: `enforce: strict requires when — it tells the validator which files must belong to a node of this type. Without when, there's no condition to evaluate.`,
        next: `Either add a when predicate to type '${typeId}', or remove enforce: strict. Run yg schemas read architecture.`,
      };
      issues.push({
        severity: 'error',
        code: 'enforce-strict-without-when',
        rule: 'enforce-strict-without-when',
        ...issueMsg(msgData),
        messageData: msgData,
      });
    }
  }
  return issues;
}
export function checkTypeWithoutWhenWithMapping(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [nodePath, node] of graph.nodes) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef === undefined) continue;
    if (typeDef.when !== undefined) continue;
    const mapping = node.meta.mapping ?? [];
    if (mapping.length === 0) continue;

    const preview = mapping.slice(0, 3).map((m) => `  - ${toPosixPath(m)}`).join('\n');
    const ellipsis = mapping.length > 3 ? `\n  ... (${mapping.length - 3} more)` : '';
    const msgData: IssueMessage = {
      what: `Node '${nodePath}' has type '${node.meta.type}' (no \`when\` — organizational type) but mapping is not empty:\n  mapping:\n${preview}${ellipsis}`,
      why: `Types without \`when\` are organizational (parent-only). Nodes of such types cannot have mapped files.`,
      next: `Add a \`when\` predicate to type '${node.meta.type}' in yg-architecture.yaml, move the file(s) to a node whose type has \`when\`, or empty this node's mapping.`,
    };
    issues.push({
      severity: 'error',
      code: 'type-without-when-with-mapping',
      rule: 'type-without-when-with-mapping',
      nodePath,
      ...issueMsg(msgData),
      messageData: msgData,
    });
  }
  return issues;
}
export async function checkTypeWhenMismatch(
  graph: Graph,
  cache: FileContentCache,
): Promise<{ issues: ValidationIssue[]; unreadable: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef === undefined || typeDef.when === undefined) continue;
    // A mapping entry is satisfied by the FILES it owns, not by the literal
    // entry STRING. Expand each entry through the SAME canonical helper the
    // mapping/coverage layer uses (expandMappingPaths), so type-when
    // classification matches ownership byte-for-byte: a glob yields its matches,
    // a DIRECTORY (e.g. src/emails/) yields the files inside it, and an existing
    // exact file resolves to just that file. expandMappingPaths returns POSIX
    // paths; the extra toPosixPath is a belt-and-suspenders forward-slash
    // guarantee for every relPath written into a diagnostic below.
    const mapping = node.meta.mapping ?? [];
    const pathsToCheck: string[] = [];
    for (const entry of mapping) {
      const expanded = (await expandMappingPaths(projectRoot, [entry])).map(toPosixPath);
      if (expanded.length > 0) {
        pathsToCheck.push(...expanded);
      } else if (!isGlobPattern(entry)) {
        // A non-glob entry that resolves to nothing on disk is a MISSING exact
        // file. Check it as-is so a content-predicate `when` still reports
        // file-unreadable on a file it cannot open (expandMappingPaths silently
        // drops missing paths, which would otherwise swallow that diagnostic).
        // An empty GLOB, by contrast, legitimately matches no files here — its
        // empty match is reported by checkMappingPathsExist, so push nothing.
        // Normalize the raw entry to POSIX form (as the sibling branch does for
        // expandMappingPaths' output) because it flows on into CLI-facing
        // diagnostic strings below as `relPath`.
        pathsToCheck.push(toPosixPath(entry));
      }
    }
    // Apply the child-precedence (child-wins) carve-out to the assembled path
    // set, matching computeExpectedPairs/computeNodeMappedFiles. A file that a
    // descendant node's mapping claims is owned by that child, so it must be
    // classified against the CHILD's type, not this ancestor's — folding it into
    // the ancestor's type-when check is a false refusal (e.g. a `repository`
    // parent globbing a directory where a `service` child carves out one file).
    // Filter the final list (not per-entry) so both the expand branch and the
    // missing-exact-file branch above are covered.
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    const filteredPaths = excludePrefixes.length > 0
      ? pathsToCheck.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
      : pathsToCheck;
    for (const relPath of filteredPaths) {
      const absPath = path.join(projectRoot, relPath);
      const result = await evaluateFileWhen(typeDef.when, {
        absPath,
        repoRelPath: relPath,
        projectRoot,
        cache,
      });

      if (result.unreadable) {
        const msgData: IssueMessage = {
          what: `Validator could not read '${relPath}' for when evaluation.\nOS error: ${result.unreadableReason ?? 'unknown'}`,
          why: `Type classification requires reading file content for content: predicates. Files that cannot be opened cannot be classified.`,
          next: `Fix file permissions, or remove the file from the node's mapping if it's not actually source code.`,
        };
        unreadable.push({
          severity: 'error',
          code: 'file-unreadable',
          rule: 'file-unreadable',
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }

      if (!result.result) {
        const msgData: IssueMessage = {
          what: `File '${relPath}' is in mapping of node '${nodePath}' (type: ${node.meta.type}) but does not satisfy '${node.meta.type}'.when:\n${renderTrace(result.trace, '  ')}`,
          why: `When a node is declared as type '${node.meta.type}', every file in its mapping must satisfy the type's when predicate. This ensures type-default aspects apply to relevant code only.`,
          next: `Options:\n  1. Move file to a node of a different type that fits\n     (run: yg type-suggest --file ${relPath})\n  2. Refactor the file so it satisfies ${node.meta.type}.when\n  3. Broaden '${node.meta.type}'.when in yg-architecture.yaml`,
        };
        issues.push({
          severity: 'error',
          code: 'type-when-mismatch',
          rule: 'type-when-mismatch',
          nodePath,
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
    }
  }
  return { issues, unreadable };
}

export function checkArchitectureConstraints(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // invalid-relation-target and invalid-parent-type require architecture to be defined and loaded
  // Only validate if architecture has node_types entries
  if (!graph.architecture || Object.keys(graph.architecture.node_types).length === 0) {
    return issues;
  }

  // type-undefined: node uses a type not defined in architecture
  issues.push(...checkNodeTypesExist(graph));

  // invalid-relation-target (sync, no I/O)
  issues.push(...checkArchitectureRelations(graph));

  // invalid-parent-type (sync, no I/O)
  issues.push(...checkArchitectureParents(graph));

  return issues;
}

export function checkNodeTypesExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(Object.keys(graph.architecture!.node_types));

  for (const [nodePath, node] of graph.nodes) {
    if (!allowedTypes.has(node.meta.type)) {
      const msgData: IssueMessage = {
        what: `Node type '${node.meta.type}' is not defined in yg-architecture.yaml.`,
        why: `Allowed types: ${[...allowedTypes].join(', ')}.`,
        next: `Add '${node.meta.type}' to yg-architecture.yaml or change the node type.`,
      };
      issues.push({
        severity: 'error',
        code: 'type-undefined',
        rule: 'unknown-node-type',
        ...issueMsg(msgData),
        messageData: msgData,
        nodePath,
      });
    }
  }
  return issues;
}

/**
 * integration-aspect-missing
 * When a node consumes a port, that port's required aspects must be defined in aspects/.
 */
export function checkPortAspectsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      const target = graph.nodes.get(rel.target);
      if (!target?.meta.ports) continue;

      for (const portName of rel.consumes ?? []) {
        const port = target.meta.ports[portName];
        if (!port) continue; // unknown-port catches this
        for (const aspectId of port.aspects) {
          if (!definedAspects.has(aspectId)) {
            const msgData: IssueMessage = {
              what: `Port '${portName}' on '${rel.target}' requires aspect '${aspectId}', which is not defined in aspects/.`,
              why: `Port contracts are broken when a required aspect is missing — the consumer's obligation cannot be verified.`,
              next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
            };
            issues.push({
              severity: 'error',
              code: 'port-missing-aspect',
              rule: 'integration-aspect-missing',
              nodePath,
              ...issueMsg(msgData),
              messageData: msgData,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * invalid-relation-target
 * Relation target type must be in architecture's allowed list for the relation type.
 */
export function checkArchitectureRelations(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig || !node.meta.relations || node.meta.relations.length === 0) {
      continue;
    }

    const lists = typeConfig.relations;
    const def = typeConfig.relationDefault ?? 'allow';

    // Fast path: nothing constrains this type's relations.
    if ((!lists || Object.keys(lists).length === 0) && def === 'allow') {
      continue;
    }

    for (const rel of node.meta.relations) {
      const allowed = lists?.[rel.type];
      const target = graph.nodes.get(rel.target);
      if (!target) continue; // relation-target-missing catches this

      if (allowed !== undefined) {
        // Explicit list (including []). '*' matches any target type.
        if (allowed.includes('*') || allowed.includes(target.meta.type)) continue;
        const msgData: IssueMessage = {
          what: `Relation '${rel.type}' from '${nodePath}' to '${rel.target}' (type '${target.meta.type}') is not allowed by the architecture.`,
          why: `Allowed targets for '${rel.type}' from type '${node.meta.type}': [${allowed.join(', ')}]`,
          next: `Either change the relation type, change the target node's type, or update yg-architecture.yaml to allow this relation.`,
        };
        issues.push({
          severity: 'error',
          code: 'relation-target-forbidden',
          rule: 'invalid-relation-target',
          nodePath,
          ...issueMsg(msgData),
          messageData: msgData,
        });
      } else if (def === 'deny') {
        const msgData: IssueMessage = {
          what: `Relation '${rel.type}' from '${nodePath}' to '${rel.target}' (type '${target.meta.type}') is not allowed by the architecture.`,
          why: `Type '${node.meta.type}' denies relation '${rel.type}' by default (relations.default: deny, and no allow-list entry permits this target).`,
          next: `Open '${rel.type}' for type '${node.meta.type}' in yg-architecture.yaml (list target types, or ['*'] for any), change a node's type, or remove the relation.`,
        };
        issues.push({
          severity: 'error',
          code: 'relation-target-forbidden',
          rule: 'invalid-relation-target',
          nodePath,
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
      // else: unlisted + default allow ⇒ permitted
    }
  }

  return issues;
}

/**
 * invalid-parent-type
 * Parent type must be in architecture's allowed list for this node type.
 */
export function checkArchitectureParents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig?.parents || !node.parent) {
      continue;
    }

    if (!typeConfig.parents.includes(node.parent.meta.type)) {
      const msgData: IssueMessage = {
        what: `Node '${node.path}' (type '${node.meta.type}') has parent '${node.parent.path}' of type '${node.parent.meta.type}', which is not an allowed parent type.`,
        why: `Allowed parent types for '${node.meta.type}': [${typeConfig.parents.join(', ')}]`,
        next: `Either move this node under an allowed parent type, change this node's type, or update yg-architecture.yaml to allow this parent.`,
      };
      issues.push({
        severity: 'error',
        code: 'parent-type-forbidden',
        rule: 'invalid-parent-type',
        nodePath,
        ...issueMsg(msgData),
        messageData: msgData,
      });
    }
  }

  return issues;
}

/**
 * missing-consumes
 * When a relation target has non-empty ports, the consumer must declare which port(s) it consumes.
 *
 * unknown-port
 * When a consumer's consumes list references a port name that does not exist on the target.
 */
export function checkPortConsumes(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      // Port contracts apply to EVERY relation type, including event relations
      // (emits/listens): channel-6 aspect propagation does not skip them, so the
      // consumes contract must be enforced uniformly for consistency.
      const target = graph.nodes.get(rel.target);
      const hasPorts = target?.meta.ports && Object.keys(target.meta.ports).length > 0;

      // consumes-without-ports: consumes on a relation to a target without ports
      if (!hasPorts && rel.consumes && rel.consumes.length > 0) {
        const msgData: IssueMessage = {
          what: `Relation '${rel.type}' to '${rel.target}' declares consumes [${rel.consumes.join(', ')}], but the target has no ports.`,
          why: `consumes is only meaningful when the target declares ports with required aspects.`,
          next: `Remove consumes from this relation in yg-node.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'consumes-without-ports',
          rule: 'consumes-without-ports',
          nodePath,
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }

      if (!hasPorts) continue;
      const ports = target!.meta.ports!;

      // missing-consumes: target has ports but consumer has no consumes
      if (!rel.consumes || rel.consumes.length === 0) {
        const portNames = Object.keys(ports);
        const msgData: IssueMessage = {
          what: `Node '${nodePath}' relates (${rel.type}) to '${rel.target}', which declares ports, but the relation has no consumes.`,
          why: `Target has ports: [${portNames.join(', ')}] — port-required aspects won't be verified without a consumes declaration.`,
          next: `Add consumes: [<port-names>] to this relation in yg-node.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'port-missing-consumes',
          rule: 'missing-consumes',
          nodePath,
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }

      // unknown-port: consumes references non-existent port
      for (const portName of rel.consumes) {
        if (!(portName in ports)) {
          const available = Object.keys(ports);
          const msgData: IssueMessage = {
            what: `Relation: ${rel.type} -> ${rel.target}, port '${portName}' not found.`,
            why: `Port contract cannot be enforced for an undefined port. Available ports: [${available.join(', ')}]`,
            next: `Fix the port name in consumes, or add the port definition to the target node.`,
          };
          issues.push({
            severity: 'error',
            code: 'port-undefined',
            rule: 'unknown-port',
            nodePath,
            ...issueMsg(msgData),
            messageData: msgData,
          });
        }
      }
    }
  }

  return issues;
}

export const summary = 'Node definition — type, mapping, aspects, relations, ports, log.';

export const content = `# yg-node.yaml — Schema for model nodes
# Every node is a directory under .yggdrasil/model/ containing this file.
# The node's path in the graph = its directory path relative to model/.
# Nodes nest by directory — a node at model/orders/handler/ is a child
# of model/orders/ and inherits its parent's aspects.

name: ComponentName           # required — display name
type: service                 # required — must match a type defined in yg-architecture.yaml
description: "What this node does"  # required — shown in context output and helps agents
                                    # understand purpose. Validator emits description-missing if absent.

aspects:                      # optional — aspect identifiers applied directly to this node.
                              # Two forms per entry:
  - simple-aspect             #   bare string — always effective once attached (channel 1)
  - id: conditional-aspect    #   object form — attach with per-site applicability filter
    status: enforced          #   optional — explicit status override (channel 1).
                              #   Must satisfy bump rule (bump up OK, downgrade is validator error).
    when: <predicate>         #   optional — see yg schemas read aspect for grammar
                              # Aspects cascade to all child nodes.

ports:                        # optional — named entry points with required aspects
  port-name:                  # consumers of this node reference ports via consumes
    description: "What this port provides"  # required
    aspects:                  # required — aspects consumers must satisfy (channel 6)
      - simple-aspect         #   bare string form
      - id: conditional-aspect
        status: enforced      #   optional — explicit status override (channel 6).
                              #   Must satisfy bump rule (bump up OK, downgrade is validator error).
        when: <predicate>     #   optional — see yg schemas read aspect for grammar

relations:                    # optional — outgoing dependencies to other nodes
                              # Load-bearing, not just documentation: a built-in deterministic check
                              # parses this node's mapped code and REFUSES it (relation-undeclared-dependency,
                              # always an error) if it depends on another mapped node without a relation here.
                              # One-directional — a declared relation needs no code behind it. See
                              # \`yg knowledge read ports-and-relations\`.
  - target: other/module-path # required — node path relative to model/
    type: calls               # required — calls | uses | extends | implements | emits | listens
    consumes: [port-name]     # optional — port names consumed from target
                              # required when target declares ports — otherwise yg check emits a
                              # BLOCKING ERROR (port-missing-consumes) that fails the architecture gate.
                              # There is no waiver; resolve by adding consumes or removing the ports.
                              # Naming a target that declares no ports raises consumes-without-ports.
    event_name: order.placed  # optional — ONLY for the event relation types (emits / listens):
                              # the named channel the two ends share. emits and listens must be
                              # PAIRED — every emits on one node needs a matching listens (same
                              # event_name) on another, and vice versa, or yg check emits the
                              # BLOCKING event-unpaired error. Ignored on structural relation types.

mapping:                      # optional — source files and directories owned by this node
  - src/modules/component/    # directory — all files inside are owned (recursive)
  - src/modules/component.ts  # file — exact match
  - src/db/*Repository.cs     # glob — minimatch: * matches within one path segment,
  - src/**/*.ts               #        ** matches across segments (recursive)
                              # paths are relative to repository root
                              # each source file must have exactly one owner node — except that a
                              # child node claiming a specific file inside a directory its parent
                              # globs owns that file (child precedence), with no overlap error

max_direct_relations:         # optional — reviewed-seam override of the built-in
                              # high-fan-out warning FOR THIS NODE ONLY. It SETS this
                              # node's own direct-relation ceiling, REPLACING the global
                              # default (quality.max_direct_relations) for this node — the
                              # declared limit may be HIGHER than the global (a deliberate
                              # single-responsibility seam — one auditable gateway or
                              # orchestrator that concentrates coupling by design) OR LOWER
                              # (holding this node to a stricter budget than the rest of the
                              # repo). The global default stays in force for every other
                              # node, and this node still warns if it exceeds the number
                              # declared here — the allowance sanctions a specific, reviewed
                              # count, it does not silence genuine over-connection. Both
                              # fields are required; a partial or malformed override (including
                              # a limit below 1) is ignored (the strict global default applies).
                              # It is a check parameter only — never a verdict input, so
                              # declaring it re-verifies nothing.
  limit: 25                   #   required — this node's own ceiling (integer >= 1); may be
                              #   above OR below the global default
  reason: "Single gateway that concentrates coupling by design; splitting defeats the seam."
                              #   required — human justification, recorded in the graph
`;

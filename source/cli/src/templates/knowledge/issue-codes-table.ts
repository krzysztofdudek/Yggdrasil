// GENERATED from source/cli/src/utils/issue-code-registry.ts — do not edit by hand.
// Edit the registry, then run `npm run codes:update` in source/cli.
// The knowledge cli-reference topic interpolates this table.

export const ISSUE_CODES_TABLE = `### Loading the graph

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`yaml-invalid\` | error | A graph file (yg-node.yaml, yg-aspect.yaml, a flow's yg-flow.yaml) does not parse, is not a YAML mapping or breaks its schema — or a directory under flows/ has no yg-flow.yaml — so what it declares is not loaded; the rest of the graph is. | Fix the file the finding names (yg schemas read gives each file's keys); the rest of the report may be a symptom of it. |
| \`config-invalid\` | error | yg-config.yaml (or yg-secrets.yaml) does not parse or holds a value of the wrong shape; every setting falls back to its default until it does. | Correct what the finding quotes in .yggdrasil/yg-config.yaml; findings computed on the defaults clear with it. |
| \`architecture-invalid\` | error | yg-architecture.yaml does not parse, so no architecture rule (types, parents, allowed relations) is checked. | Fix the YAML in .yggdrasil/yg-architecture.yaml. |
| \`lock-invalid\` | error | A committed lock file (yg-lock.nondeterministic.json, yg-lock.logs.json, or a legacy yg-lock.json) is unparseable, garbled, conflict-markered or of an unknown version — fail closed. The gitignored .yg-lock.deterministic.json is exempt: a fault there is discarded and the cache rebuilt. | Restore the lock from version control (on a merge conflict take one side whole), then run yg check --approve; never hand-edit it. |
| \`when-predicate-invalid\` | error | A \`when:\` predicate in yg-architecture.yaml does not parse, so the architecture is not loaded. | Fix the predicate; yg schemas read architecture gives the grammar. |
| \`config-unknown-key\` | error | A top-level key yg-config.yaml or yg-secrets.yaml does not know — whatever it was meant to set is not set. The rest of the configuration is in effect. | Rename the key to the one it is a typo of (the finding names it) or remove it. |
| \`config-reviewer-unknown-key\` | error · stops \`--approve\` | reviewer: holds a key other than \`default\` and \`tiers\`. | Move provider settings into a tier's config: section, or remove the key. |
| \`config-tiers-missing\` | error · stops \`--approve\` | reviewer: has no tiers: mapping. | Add reviewer.tiers with at least one tier, or remove the reviewer: section. |
| \`config-tiers-empty\` | error · stops \`--approve\` | reviewer.tiers is an empty mapping. | Add at least one tier. |
| \`config-tier-invalid\` | error | A tier under reviewer.tiers is not a mapping. | Write the tier as { provider, consensus, config: { model } }. |
| \`config-tier-name-invalid\` | error · stops \`--approve\` | A tier name does not start with a letter or holds characters other than letters, digits, \`_\` and \`-\` (at most 63). | Rename the tier, and every reviewer.tier: that names it. |
| \`config-tier-name-reserved\` | error · stops \`--approve\` | A tier is named \`default\`, which reads as reviewer.default pointing at itself. | Rename the tier, and every reviewer.tier: that names it. |
| \`config-tier-unknown-key\` | error · stops \`--approve\` | A tier, or a tier's config:, holds a key it does not accept — the setting it was meant to change stays at its default. | Rename the key to the one it is a typo of (the finding names it) or remove it. |
| \`config-tier-provider-missing\` | error · stops \`--approve\` | A tier declares no provider:. | Add provider: with one of the known providers. |
| \`config-tier-provider-unknown\` | error · stops \`--approve\` | A tier names a provider the CLI does not know how to call. | Use one of the providers the finding lists. |
| \`config-tier-config-missing\` | error · stops \`--approve\` | A tier has no config: section. | Add config: { model: <name> } (claude-code alone takes no model). |
| \`config-tier-config-not-mapping\` | error · stops \`--approve\` | A tier's config: is not a mapping. | Write config: as a mapping of provider settings. |
| \`config-tier-config-invalid\` | error · stops \`--approve\` | A value in a tier's config: has the wrong type (a model that is not a string, a timeout that is not a number). | Set the value the finding names to the type it asks for. |
| \`config-tier-consensus-invalid\` | error · stops \`--approve\` | A tier's consensus is missing, not a positive integer, or even — an even vote cannot break a tie. | Set consensus: 1, or an odd number of 3 or more for a majority vote. |
| \`config-tier-prompt-chars-invalid\` | error | A tier's max_prompt_chars is zero, negative or fractional. | Set max_prompt_chars to a positive integer, or remove it for the default. |
| \`config-tier-endpoint-missing\` | error | An openai-compatible tier has no config.endpoint, so it would fall back to the public OpenAI API. | Add config.endpoint pointing at the compatible server. |
| \`config-default-tier-missing\` | error · stops \`--approve\` | Several tiers are configured and reviewer.default does not say which one a rule without reviewer.tier uses. | Set reviewer.default to one of the configured tier names. |
| \`config-default-tier-unknown\` | error · stops \`--approve\` | reviewer.default is not a string, or names a tier that is not configured. | Set reviewer.default to one of the configured tier names. |
| \`config-coverage-unknown-key\` | error | coverage: holds a key other than \`required\`, \`excluded\` and \`type_level\`. | Rename the key to the one it is a typo of, or remove it. |
| \`config-quality-unknown-key\` | error | quality: holds a key it does not know — the threshold it was meant to set stays at its default. | Rename the key to the one it is a typo of (the finding names it), or remove it. |
| \`config-progressive-unknown-key\` | error | progressive: holds a key other than \`reference\`, or is not a mapping. | Write progressive: { reference: <branch> }, or remove the key. |
| \`config-events-unknown-key\` | error | events: holds a key other than \`committed_llm\`, or is not a mapping. | Write events: { committed_llm: true\\|false }, or remove the key. |
| \`config-signals-unknown-key\` | error | signals: holds a key other than \`attention\`, or is not a mapping. | Write signals: { attention: true\\|false }, or remove the key. |
| \`config-rules-artifacts-unknown-key\` | error | rules_artifacts: holds a key other than \`agents_md\`, \`claude_md\` and \`clinerules\`, a non-boolean value, or is not a mapping. | Set each of the three to true or false, or remove the key (absent means true). |
| \`config-rules-artifacts-orphan-import\` | error | rules_artifacts turns claude_md on while agents_md is off — CLAUDE.md would import an AGENTS.md block nobody writes. | Turn agents_md on, or claude_md off. |
| \`aspect-invalid-id\` | error | A rule directory yields an empty rule id. | Rename the directory under aspects/ to the intended rule id. |
| \`aspect-name-missing\` | error | A yg-aspect.yaml has no name:. | Add name: to the file. |
| \`aspect-unknown-key\` | error | A yg-aspect.yaml holds a key it does not accept (a typo such as \`stauts:\`); the rule is not loaded until it is corrected. | Rename the key to the one it is a typo of (the finding names it), or remove it. |
| \`aspect-field-invalid\` | error | A yg-aspect.yaml (with its adaptation, for an installed rule) holds a value of the wrong type for a key it accepts — a description that is a list, a reference description that is a number; the rule is not loaded until it is corrected. | Set the value the finding names to the type it asks for; yg schemas read aspect gives each key's type. |
| \`aspect-status-invalid\` | error | A declared status: is not one of draft, advisory, enforced. | Set status: to draft, advisory or enforced. |
| \`aspect-review-by-malformed\` | error | A rule's review_by: is present but not a calendar-valid bare YYYY-MM-DD date (2027-13-01, 2027-02-30). Fired only on the rule that carries the field. | Write review_by: as a real YYYY-MM-DD date — with the user's approval, since the date is theirs. |
| \`aspect-errs-invalid\` | error | errs: is not one of over, under, exact, or is declared on a rule that is not a script rule. | Set errs to over, under or exact on a script rule, or remove it. |
| \`aspect-scope-invalid\` | error | scope: is not a mapping, or its per:/files: do not have the accepted form. | Write scope: { per: node\\|file, files: [<glob>] }; yg schemas read aspect gives the shape. |
| \`aspect-scope-on-aggregate\` | error | A bundle (no content.md, no check.mjs) declares scope:, which only a rule with a rule source can use. | Remove scope:, or add content.md or check.mjs to make the bundle a rule. |
| \`aspect-when-invalid\` | error | A rule's own when:, or the when: of one of its implies entries, does not parse. | Correct the predicate; yg knowledge read conditional-aspects gives the grammar. |
| \`aspect-implies-not-array\` | error | implies: is not a list. | Write implies: as a list of rule ids (or { id, when, status_inherit } entries). |
| \`aspect-implies-invalid\` | error | An implies: entry is neither a rule id nor an { id, when?, status_inherit? } mapping. | Fix the entry; yg schemas read aspect gives the shape. |
| \`implies-status-inherit-invalid\` | error | An implies entry's status_inherit: is not \`strictest\` or \`own-default\`. | Set status_inherit: to strictest or own-default. |
| \`aspect-reviewer-missing\` | error · stops \`--approve\` | A rule has no rule source (content.md or check.mjs) and implies nothing, so there is nothing to infer its kind from and it would do nothing. | Add content.md (a reviewer rule) or check.mjs (a script rule), or declare implies: to make it a bundle. |
| \`aspect-reviewer-not-mapping\` | error · stops \`--approve\` | reviewer: is present but not a mapping. | Write reviewer: as a mapping with type: and optionally tier:, or remove it (the kind is inferred from the rule source). |
| \`aspect-reviewer-type-missing\` | error · stops \`--approve\` | reviewer: is a mapping without type:. | Add type: llm, deterministic or aggregate, or remove reviewer: to have the kind inferred. |
| \`aspect-reviewer-type-invalid\` | error · stops \`--approve\` | reviewer.type is not llm, deterministic or aggregate. | Set reviewer.type to llm, deterministic or aggregate. |
| \`aspect-reviewer-unknown-key\` | error · stops \`--approve\` | reviewer: holds a key other than \`type\` and \`tier\`. | Remove the key. |
| \`aspect-reviewer-tier-invalid\` | error | reviewer.tier is empty or not a string. | Set tier: to a configured tier name, or remove it for the default tier. |
| \`aspect-tier-on-deterministic\` | error · stops \`--approve\` | A script rule sets reviewer.tier: — tiers choose a reviewer model and a script rule has none. | Remove reviewer.tier from the rule. |
| \`aspect-tier-on-aggregate\` | error · stops \`--approve\` | A bundle sets reviewer.tier: — a bundle has no verdict of its own and no reviewer. | Remove reviewer.tier from the bundle. |
| \`aspect-references-on-deterministic\` | error | A script rule declares references:, which only a reviewer is shown. | Remove references:, or read the files from check.mjs through its context. |
| \`aspect-references-on-aggregate\` | error | A bundle declares references:, which it has no reviewer to show. | Remove references: from the bundle. |
| \`aspect-reference-invalid-form\` | error | references: is not a list, or an entry is neither a path nor a { path, description } mapping. | Write each entry as a repo-relative path or { path, description }. |
| \`aspect-reference-blank-path\` | error | A references: entry has an empty path. | Give the entry a real file path, or remove it. |
| \`aspect-reference-escape\` | error | A references: entry is absolute or climbs above the repository root. | Use a path relative to the repository root. |
| \`aspect-reference-duplicate\` | error | A references: entry is listed more than once. | Remove the duplicate entry. |
| \`aspect-source-symlink\` | error | A rule source (content.md, check.mjs, companion.mjs) runs through a symbolic link — refused, never followed: a link can reach outside the repository and resolve differently on each machine. | Replace the link with the file itself. |
| \`aspect-companion-invalid\` | error | companion: is not a path string. | Set companion: to a repo-relative module path, or remove it. |
| \`aspect-companion-escape\` | error | companion: leaves the repository root. | Move the module into the repository and give companion: a repo-relative path. |
| \`aspect-companion-missing\` | error | companion: names a file that is not there or cannot be read. | Fix the path, or add the module. |
| \`aspect-packages-dir-reserved\` | error | A rule of the repository's own sits under aspects/packages/, which is reserved for installed packages; it is not loaded. | Move the rule out of aspects/packages/ (and update the ids that name it). |
| \`package-manifest-invalid\` | error | An installed package's yg-package.yaml — or, under yg marketplace check, a published one — is not valid YAML or not a mapping, or its identity disagrees with where it is published. | Reinstall the package (yg pack update), or, as its author, fix the manifest. |
| \`package-schema-unknown\` | error | An installed package's yg-package.yaml declares a schema this build does not know. | Upgrade the CLI, or install a release of the package built for this one. |
| \`package-name-invalid\` | error | An installed package's name is not a single path segment. | Reinstall the package from its marketplace; as its author, fix name:. |
| \`package-version-invalid\` | error | An installed package's version is not semver. | Reinstall the package from its marketplace; as its author, fix version:. |
| \`package-requires-missing\` | error | An installed package does not declare requires.yg, so nothing says which CLI can run it. | Install a release of the package that declares requires.yg. |
| \`package-requires-unsatisfied\` | error | A package needs a Yggdrasil version range this CLI is outside of. | Upgrade Yggdrasil to a version in the range, or install a release of the package built for this one. |
| \`package-aspects-invalid\` | error | An installed package's aspects: is absent, not a list, or lists a directory twice. | Reinstall the package from its marketplace; as its author, fix aspects:. |
| \`package-aspect-dir-missing\` | error | An installed package declares a rule directory it does not carry. | Reinstall the package (yg pack update). |
| \`package-aspect-dir-undeclared\` | error | An installed package carries a rule directory its aspects: does not declare — a rule that would ride in unannounced. | Reinstall the package (yg pack update); as its author, declare or remove the directory. |
| \`package-config-schema-invalid\` | error | An installed package's config: schema is not a mapping of rule to { key: { type, default } }. | Reinstall the package; as its author, fix config:. |
| \`package-config-schema-unknown-aspect\` | error | An installed package's config: declares settings for a rule it does not carry. | Reinstall the package; as its author, fix config:. |
| \`package-config-key-type-missing\` | error | A setting in an installed package's config: has no type, or one other than string, number, boolean. | Reinstall the package; as its author, give the setting a type. |
| \`package-config-default-type-mismatch\` | error | A setting's default in an installed package's config: is not of its declared type. | Reinstall the package; as its author, fix the default. |
| \`package-implies-not-relative\` | error | A rule of a package implies another by a full path instead of the rule's directory name inside the package. | As the package author, name the implied rule by its directory name alone. |
| \`package-implies-outside-package\` | error | A rule of a package implies a rule that package does not carry. | As the package author, imply only the package's own rules. |
| \`aspect-adapt-invalid\` | error | An installed rule's adaptation file (yg-aspect.adapt.yaml) is not valid YAML. | Fix the YAML syntax in the adaptation file. |
| \`aspect-adapt-not-mapping\` | error | An adaptation file is not a mapping. | Write the adaptation as a YAML mapping, e.g. status: advisory. |
| \`aspect-adapt-key-not-adaptable\` | error | An adaptation sets a key a package rule does not let a consumer change (its content, its check, its scope). | Remove the key; the finding lists the adaptable keys. |
| \`aspect-adapt-key-unknown\` | error | An adaptation sets a key that is no key of an adaptation. | Remove or rename the key; the finding lists the adaptable keys. |
| \`aspect-adapt-config-not-mapping\` | error | An adaptation's config: is not a mapping. | Write config: as a mapping of setting to value. |
| \`aspect-adapt-config-key-unknown\` | error | An adaptation sets a config key the package does not declare for the rule. | Remove the key; the package's yg-package.yaml lists the settings it reads. |
| \`aspect-adapt-config-type-mismatch\` | error | An adaptation sets a config key to a value of another type than the package declares. | Give the setting a value of the declared type. |

### Graph validation

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`config-committed-api-key\` | error | The committed yg-config.yaml holds a reviewer api_key — a credential every clone and fork receives. | Move the key to the gitignored .yggdrasil/yg-secrets.yaml (or the provider's environment variable), then revoke and replace it. |
| \`secrets-file-tracked\` | error | .yggdrasil/yg-secrets.yaml, the local credentials overlay, is tracked by git. | git rm --cached .yggdrasil/yg-secrets.yaml, keep it gitignored, and revoke any key it held. |
| \`reviewer-endpoint-committed\` | warning | A tier of a hosted provider sends the environment's API key to an endpoint named in the committed yg-config.yaml — over plain http, or to a host other than the provider's own. | If the endpoint is yours, move config.endpoint into yg-secrets.yaml; otherwise remove it and unset the key before a fill on this branch. |
| \`config-reviewer-missing\` | error (enforced) / warning (advisory) · stops \`--approve\` | An effective reviewer rule and no reviewer: section in yg-config.yaml. Follows the strictest status among the reviewer pairs left without a reviewer. Stops a full yg check --approve; never stops --only-deterministic or --dry-run. | yg init --provider <name> [--model <m>] (the user's decision), or set the reviewer rules to status: draft. |
| \`architecture-cycle\` | error | The parents: declarations of some node types form a cycle with no rootable type (one with no parents:, or with root among them), so nodes of those types can never be placed. | Add root to one of the types' parents: so it may sit at the top level, add a rootable parent, or remove one parents: entry. |
| \`type-undefined\` | error | A node's type: is not defined in yg-architecture.yaml. | Define the type in yg-architecture.yaml (the user's decision) or change the node's type. |
| \`type-undefined-pending\` | warning | A node names a type while yg-architecture.yaml declares no node types yet; types are not checked until the first one is. | Define the type under node_types in yg-architecture.yaml (the user's decision). |
| \`type-name-reserved\` | error | A node type is named root, the reserved parents: entry for the top level of the model. | Rename the type in yg-architecture.yaml and in every node that declares it (the user's decision). |
| \`type-unknown-parent\` | error | A type's parents: names a type that is not defined (root, the top level, is the one entry that names no type). | Define the parent type, or remove it from parents:. |
| \`parent-type-forbidden\` | error | A node sits under a parent whose type is not one of its own type's allowed parents, or at the top level while its type's parents: do not name root. | Move the node, change a type, or allow the parent (root for the top level) in yg-architecture.yaml (the user's decision). |
| \`type-when-mismatch\` | error · a warning outside your change | A file in a node's mapping does not satisfy its type's when: predicate. | Move the file to a node of a fitting type (yg type-suggest --file <file>), refactor it, or broaden the type's when: (the user's decision). |
| \`type-without-when-with-mapping\` | error | A node of an organizational type (one with no when:) maps files. | Add a when: to the type, move the files to a node of a type that has one, or empty the node's mapping. |
| \`enforce-strict-without-when\` | error | A type sets enforce: strict without a when: predicate, so there is nothing to enforce. | Add a when: to the type, or remove enforce: strict. |
| \`relation-target-type-unknown\` | error | A type's relations: allow-list names a target type that is not defined (and is not \`*\`), which silently over-restricts the relation. | Fix the spelling, define the type, use '*', or remove the entry. |
| \`architecture-default-aspect-unreachable\` | warning | A type's own default rule is effective on none of that type's instances — its when: filters it off the type that declares it. | Widen or remove the when:, or drop the default; for a per: node default whose type has only type-covered files, give a file a node of its own or make the rule per: file. |
| \`node-yaml-missing\` | error | A directory under model/ holds files but no yg-node.yaml. | Create yg-node.yaml there, or move the files to a node directory. |
| \`node-unreachable\` | error | A yg-node.yaml the loader never reached — under a directory that is no node, or beneath a node that failed to load — so nothing it declares is enforced. | Give every directory above it a yg-node.yaml, or fix the node above it that failed to load. |
| \`invalid-scope\` | error | A validation was asked for a node the graph does not contain. | yg find "<node>" to locate the node you meant. |
| \`description-missing\` | error · a warning outside your change | A node, rule or flow has no description, which context output depends on. | Add a description: to its yaml. |
| \`overlapping-mapping\` | error | Two nodes' mapping entries overlap, so a file would have two owners. | Keep one owner mapping and model the other concern with a relation. |
| \`file-duplicate-mapping\` | error | One file appears in the mappings of more than one node. | Remove the file from all but the node that owns it. |
| \`file-mapping-gitignored\` | error | A literal mapping entry names a gitignored file, which the disk walk never sees. | Un-ignore the file, or remove it from the mapping. |
| \`file-mapping-excluded\` | error | A mapping entry names a file coverage.excluded cuts out, so it is never enforced however deliberately it is mapped. | Remove the file from the mapping, or narrow the exclusion. |
| \`mapping-escapes-repo\` | error · stops \`--approve\` | A mapping entry is absolute or climbs above the repository root. | Make the entry repo-relative, with no .. above the root. |
| \`mapping-path-missing\` | error | A mapping entry — a path or a glob — matches nothing on disk. | Fix the entry, or remove it. |
| \`mapping-path-case-mismatch\` | error | A mapping entry matches a file only case-insensitively; on a case-sensitive file system (CI) it matches nothing. | Spell the entry exactly as the file is named. |
| \`file-unreadable\` | error | A file a check had to read — a mapped source, a file a type's content: predicate scans, a log — could not be read, or exceeds the content-scan limit. | Make the file readable, or take it out of what the check reads (gitignore, coverage.excluded, or drop the content: atom). |
| \`port-undefined\` | error | A relation names a port the target node does not declare. | Name one of the ports the finding lists, or declare the port on the target. |
| \`port-missing-aspect\` | error | A port requires a rule that is not defined. | Create the rule under aspects/, or remove it from the port. |
| \`relation-broken\` | error | A relation targets a node the graph does not contain. | Correct the target in the node's relations:, or remove the relation. |
| \`relation-target-forbidden\` | error | A relation's type is not allowed between the two nodes' types by the architecture. | Change the relation type or a node type, or allow it in yg-architecture.yaml (the user's decision). |
| \`structural-cycle\` | error | The declared structural relations (calls / uses / extends / implements) form a cycle — including a node relating to itself. Not an aspect: no status, not suppressible. Reported once per group of nodes that reach each other. | Break the cycle: extract the shared piece into a third node both depend on, or invert one dependency. |
| \`event-unpaired\` | error | An emits relation has no matching listens on the other side (or the reverse). | Add the matching listens (or emits) relation, or remove the unpaired one. |
| \`high-fan-out\` | warning | A node has more direct relations than quality.max_direct_relations. | Split the node, or route its relations through an intermediary node. |
| \`flow-node-broken\` | error | A flow names a node that does not exist, or whose yg-node.yaml did not load. | Fix the node name in the flow, or the node's yaml. |
| \`aspect-unexpected-rule-source\` | error | A bundle (implies only, no reviewer.type) ships a rule source that is never read. | Remove the rule source to keep the bundle, or declare reviewer.type to make it a rule. |
| \`aspect-missing-rule-source\` | error | A rule's declared reviewer.type has no matching rule source (llm without content.md, deterministic without check.mjs). | Add the rule source its type needs, or change reviewer.type. |
| \`aspect-both-rule-sources\` | error | A rule ships both content.md and check.mjs. | Remove the rule source that does not match its kind. |
| \`aspect-empty\` | error | A rule has no content.md, no check.mjs and no implies — it does nothing. | Add a rule source or implies:, or remove the rule. |
| \`aspect-companion-without-content\` | error | A rule ships companion.mjs without content.md; a companion is an add-on to a reviewer rule. | Add content.md, or remove companion.mjs. |
| \`aspect-companion-with-check\` | error | A rule ships companion.mjs beside check.mjs; companions apply to reviewer rules only. | Remove companion.mjs, or make the rule a reviewer rule. |
| \`aspect-references-empty-array\` | warning | A rule declares references: [] — an empty list that does nothing. | Fill the list, or remove the references: line. |
| \`aspect-reference-broken\` | error | A references: entry names a file that does not exist. | Create the file, fix the path, or remove the entry. |
| \`aspect-reference-symlink\` | error · stops \`--approve\` | A references: entry runs through a symbolic link; no fill runs until it is replaced by the file itself. | Reference the file itself instead of the link, or remove the entry. |
| \`aspect-tier-unknown\` | error · stops \`--approve\` | A rule names a reviewer tier that is not configured. | Name a configured tier, or remove reviewer.tier for the default. |
| \`aspect-undefined\` | error | A node, type, flow or port attaches a rule id that no directory under aspects/ defines. | Create the rule, or fix or remove the attach. |
| \`duplicate-aspect-id\` | error | Two rules resolve to one id. | Rename one of the rule directories. |
| \`implied-aspect-missing\` | error | A rule implies a rule id that does not exist. | Create the implied rule, or remove it from implies:. |
| \`aspect-implies-cycle\` | error · stops \`--approve\` | The implies: edges form a cycle, so effective rules cannot be resolved. | Remove one implies edge of the cycle. |
| \`aspect-status-downgrade\` | error | An attach site declares a status lower than the cascade yields (raising is allowed, lowering is not). | Remove the lower status:, or lower the rule's own status (the user's decision). |
| \`aspect-status-changed-outside-cli\` | warning | A rule's status changed and its own log records no reason; a full fill writes the bare fact into that log if nobody does. | yg aspects log add --aspect <rule> --status <status> --evidence '<what justified it>' --reason '<why>'. |
| \`aspect-effective-nowhere\` | warning | A rule that ships a rule source and is not draft is effective on zero nodes after the full cascade and every when: — it looks enforced and verifies nothing. | Fix the attach sites or when:, or set status: draft until what it targets exists; for a per: node rule whose type has only type-covered files, give a file a node or make the rule per: file. |
| \`orphaned-aspect\` | warning | A bundle, a draft rule, or a rule in a graph with no code yet is attached nowhere. | Attach it to a node, type or flow, or remove it. |
| \`aspect-review-overdue\` | warning | A rule's review_by: date has passed — it is running unreviewed. Never blocks and never writes a verdict. | Ask the user to renew or retire the rule; never change the date yourself. |
| \`when-unknown-type\` | error | A when: predicate names a node type that is not defined. | Fix the type name, or define the type. |
| \`when-unknown-node\` | error | A when: predicate names a node that does not exist. | Fix the node path, or create the node. |
| \`when-unknown-port\` | error | A when: predicate's consumes_port names a port the target node does not declare. | Fix the port name, or declare the port on the target. |
| \`when-unmatched-port\` | warning | A has_port predicate names a port no node declares, so it is false everywhere. | Fix the port name if it is a typo; leave it if the never-match is deliberate. |
| \`package-file-modified\` | error | A file installed from a package no longer matches what the package published — edited, missing, or never installed — or the record of installed packages cannot be read. Built in: not suppressible. | yg pack update <package> to restore it, or adapt the rule through its yg-aspect.adapt.yaml instead of editing the copy. |
| \`rules-digest-stale\` | warning | The committed agent-rules digest (the AGENTS.md block, .clinerules/yggdrasil.md, or the CLAUDE.md @AGENTS.md import) is missing, hand-edited, from an older CLI, or duplicated. Only artifacts rules_artifacts keeps on are compared. | yg init --upgrade |
| \`incident-ledger-out-of-order\` | warning | The incident ledger's entry datetimes are not strictly ascending — the mark of a hand-edit or a reordering merge. | Reorder the entries so datetimes ascend; never fabricate a datetime. |

### Pairs and the lock

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`unverified\` | error (enforced) / warning (advisory) · a warning outside your change | An expected pair has no valid verdict. Grouped, and in --json tagged \`cause\`, by why: stale, keyed by an earlier release, never reviewed, a script check not run on this checkout, no reviewer configured, or — on the report of the fill that hit it — a reviewer unreachable, a reviewer that returned no verdict, a check.mjs that failed to run, or a yg-suppress marker with no reason. | The group names the fix for its cause: yg check --approve for a pair waiting for a fill (--only-deterministic for a script pair, free), the configuration or the check for an infrastructure cause. |
| \`aspect-violation-enforced\` (heads as \`refused\`) | error · a warning outside your change | A valid refused verdict on an enforced pair — cached and final for unchanged inputs. | Fix the code, sharpen the rule (re-verifies every node using it), or a yg-suppress with the user's approval. |
| \`aspect-violation-advisory\` (heads as \`refused\`) | warning | A valid refused verdict on an advisory pair — reported, never blocks. | Fix the code, or sharpen the rule. |
| \`prompt-too-large\` | error · a warning outside your change | The assembled reviewer prompt exceeds the resolved tier's max_prompt_chars — an error at any status. Takes precedence over unverified; --approve skips the pair. | Split the node or the rule, narrow the rule's scope, or raise max_prompt_chars for the tier. |
| \`suppress-marker-missing-reason\` | warning | A yg-suppress marker in a mapped source has no reason. It waives nothing, and fails only what it would have waived: the first violation of a rule it names in its range makes the fill reject it and leave that pair unverified, and a reviewer pair of a rule it names stays unverified. Other rules are unaffected. | Add the reason (the user approves it), or remove the marker. |

### Relation conformance

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`relation-undeclared-dependency\` | error · a warning outside your change | A node depends on another node's code without a declared relation. Built in, not an aspect: no status, not suppressible, never cached. | Declare a structural relation (uses, calls, extends or implements) in the node's yg-node.yaml, or remove the dependency. |
| \`type-relation-forbidden\` | error · a warning outside your change | With coverage.type_level on, a statically resolved import between two classified endpoints (a node and/or a type-covered file) has no structural relation type (uses, calls, extends, implements) the architecture allows between their types; an event type alone sanctions no import. | Allow the type pair in yg-architecture.yaml (the user's decision), give the target an explicit node with a relation, or remove the dependency. |
| \`relation-parse-failed\` | error | A language parser the relation check needs could not be loaded, so the dependencies of the files it covers cannot be checked. | Reinstall the CLI to restore its bundled language support, then run yg check. |

### Coverage

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`unmapped-files\` (heads as \`unmapped\`) | error · a warning outside your change | Source files under a coverage.required root that no node maps and no type covers. | Map the files to a node (yg context --file <file> lists candidates), or move their root out of coverage.required. |
| \`uncovered-advisory\` (heads as \`uncovered\`) | warning | Source files outside every coverage.required root that nothing covers — shown, never blocking. | Map them to a node, or add their root to coverage.required to make this an error. |
| \`tracked-file-gitignored\` | error (required root) / warning · a warning outside your change | A file committed to git is matched by .gitignore, so every coverage and enforcement layer skips it. | Un-ignore the file, or untrack it (git rm --cached '<file>'). |
| \`ambiguous-node-type\` | error · a warning outside your change | With coverage.type_level on, an uncovered file matches two or more classifying types and the machine refuses to guess whose rules apply. | Give the file a node of the intended type, or narrow one of the types' when:. |
| \`type-strict-orphan\` | error · a warning outside your change | A file satisfies the when: of an enforce: strict type but belongs to no node of that type. | Map the file to a node of that type. |
| \`type-strict-misplaced\` | error · a warning outside your change | A file satisfies the when: of an enforce: strict type but is mapped by a node of another type. | Move the file to a node of the strict type, or refactor it off that type's when:. |
| \`strict-overlap-conflict\` | error · a warning outside your change | Files satisfy the when: of two enforce: strict types at once. | Narrow one of the two types' when: so each file belongs to one. |
| \`coverage-required-shadowed\` | warning | A plain coverage.required root sits entirely inside a plain coverage.excluded root; exclusion is absolute, so the required line can never make anything block. | Remove the required line, or narrow the excluded root. |

### The log gate

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`log-entry-missing\` | error · a warning outside your change | A log_required node changed its own source without a fresh log entry (a rule, relation, lock or verdict change never owes one). Blocking on plain yg check; stops --approve only when the run would fill a pair of that node. | yg log add --node <node> --reason "<why the change was made>" |
| \`log-cycle-open\` | warning | A log_required node's source moved past its recorded baseline and its newest entry keeps satisfying the requirement, because no full yg check --approve has recorded a new baseline (--only-deterministic never does). | A full yg check --approve. |
| \`log-integrity\` | error · stops \`--approve\` · a warning outside your change | A node's recorded log history was rewritten, or entries were inserted before its last recorded one (the shape a merge leaves). | yg log merge-resolve --node <node> after a merge; otherwise restore log.md from version control. |
| \`log-format\` | error · stops \`--approve\` · a warning outside your change | A node's log.md does not parse as log entries. | Fix the lines the finding names, or restore the file from version control. |
| \`log-conflict\` | error · stops \`--approve\` · a warning outside your change | A node's log.md still carries git conflict markers. | yg log merge-resolve --node <node> |

### Reported by a fill only

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`log-entry-required\` | error | yg check --approve stopped before filling anything: nodes it would fill pairs of owe a fresh log entry. | Add the entries (yg log add), then re-run the same fill. |
| \`aspect-companion-runtime-error\` | error (enforced) / warning (advisory) · a warning outside your change | A companion.mjs failed at fill time (threw, returned a bad shape, resolved a missing or out-of-reach path, or its observations stayed inconsistent) — fail closed, no verdict written; plain yg check shows the pair as unverified. | Fix companion.mjs (yg aspect-test --aspect <rule> --node <node> --dry-run shows what it resolves), then re-run the fill. |

### Command errors (\`yg-error/1\`)

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`usage\` | error | A flag, argument or combination of them the command does not accept. | yg <command> --help lists what it takes. |
| \`command-error\` | error | A command refused for a reason no more specific code names; what, why and next say which. | Follow the error's own next: line. |
| \`internal\` | error | An error the CLI does not classify — a bug. | File an issue with the command and its full output. |
| \`node-not-found\` | error | The command names a node the graph does not hold. Every command that takes a node answers with it. | yg find "<node>" |
| \`aspect-not-found\` | error | The command names a rule the graph does not hold. Every command that takes a rule id answers with it. | yg aspects lists every rule id. |
| \`graph-missing\` | error | There is no .yggdrasil/ graph in this directory or above it. | yg init to create one, or run from the repository that has it. |
| \`graph-load-failed\` | error | The graph could not be loaded at all (an unsupported or malformed schema version, an unreadable graph directory). | Follow the error's next: line — usually yg init --upgrade, or upgrading the CLI. |
| \`lock-environment\` | error | The lock cannot be written: another yg check --approve holds it, or writing it failed. | Wait for the other run to finish (or remove its stale marker, as the error says), then re-run. |
| \`no-coverage\` | error | yg context --file names a file that no node maps and no type covers. | yg context --node <node>, or map the file to a node. |
| \`adopt-restore-failed\` | error | yg adopt could not undo its own install after a failure, so a partly copied graph may be left in place. | Restore the graph by hand as the error describes, then run yg adopt again. |
| \`node-path-invalid\` | error | A --node value is not a node path: empty, absolute, climbing with .., or starting with model/. | Write the path relative to .yggdrasil/model/, e.g. billing/cancel. |
| \`log-merge-not-in-progress\` | error | yg log merge-resolve found no merge, rebase or cherry-pick in progress, and HEAD is not a merge commit, so there are no two sides to reconcile. | Run it during the merge (or on the merge commit), or name the sides with --ours <ref> --theirs <ref>. |
| \`log-merge-log-missing\` | error | yg log merge-resolve was asked about a node that has no log.md. | Check the node path; a node with no log has nothing to reconcile. |
| \`log-merge-conflict-markers\` | error | log.md still carries git conflict markers and no merge is in progress to write the union from. | Remove the markers, keeping every entry of both sides ordered by datetime, then run yg log merge-resolve again. |
| \`log-merge-sides-unreadable\` | error | yg log merge-resolve could not read log.md from the two sides of the merge (or from HEAD and the commit being replayed). | Check that the refs exist locally (fetch them), then run it again. |
| \`log-merge-history-rewritten\` | error | The log's shared history was changed: the merged log does not start with what both sides share, the sides share no history, or one side or the replayed commit rewrote entries it had. | Restore the shared entries unmodified (or restore the conflicted file and let yg log merge-resolve write it). |
| \`log-merge-entries-lost\` | error | The merged log.md drops or alters entries one of the sides added. | Restore the entries the error lists, byte for byte. |
| \`log-merge-entries-unknown\` | error | The merged log.md holds entries neither side added — a merge may only union the two sides. | Remove the entries the error lists. |
| \`log-merge-out-of-order\` | error | The entries after the shared history are not in date order. | Sort them by datetime, oldest first, each once. |
| \`aspect-status-value-invalid\` | error | yg aspects log add --status names something that is not draft, advisory or enforced. | Re-run with --status draft, advisory or enforced. |
| \`aspect-status-not-standing\` | error | yg aspects log add --status records a status the rule's file does not carry — it records a change, it never makes one. | Set status: in the rule's yg-aspect.yaml first, then record it. |
| \`aspect-status-evidence-missing\` | error | yg aspects log add --status was given no --evidence for the change. | Re-run with --evidence "<what justified it>". |
| \`aspect-status-unchanged\` | error | yg aspects log add --status records the status the rule already stood at, so nothing changed. | Record the note without --status, or change the status in the rule file first. |

### Packages (\`yg pack\`)

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`package-install-failed\` | error | A package could not be copied into .yggdrasil/aspects/packages/. | Fix what the error names (permissions, disk), then re-run the pack command. |
| \`package-manifest-missing\` | error | A package directory has no yg-package.yaml. | Point the pack command at a directory that holds yg-package.yaml. |
| \`package-symlink-refused\` | error | A package carries a symbolic link; installing refuses it, and yg marketplace check reports it, because a copied link resolves against the consumer's file system. | As the package author, replace the link with the file itself. |
| \`package-binary-file-refused\` | error | A package carries a binary file; installing refuses it, and yg marketplace check reports it — a rule is text a reviewer and a consumer can read. | As the package author, remove the binary file from the package. |
| \`packages-lock-invalid\` | error | .yggdrasil/yg-packages.yaml, the record of installed packages, is not valid YAML or its packages: is not a mapping. | Restore yg-packages.yaml from version control. |
| \`packages-lock-schema-unknown\` | error | yg-packages.yaml declares a schema this build does not know. | Upgrade the CLI, or restore the file from version control. |
| \`packages-lock-package-invalid\` | error | A record in yg-packages.yaml names an install directory that is not <owner>/<repo>/<package>. | Restore yg-packages.yaml from version control. |
| \`packages-lock-entry-invalid\` | error | A record in yg-packages.yaml is not a mapping, or holds a field value of the wrong form. | Restore yg-packages.yaml from version control, or re-run yg pack add for the package. |
| \`packages-lock-entry-incomplete\` | error | A record in yg-packages.yaml lacks a field every install writes. | Re-run yg pack add for the package. |
| \`packages-lock-hash-invalid\` | error | A record in yg-packages.yaml holds a file hash that is not a sha256 digest, or a files: that is not a mapping. | Re-run yg pack add for the package. |
| \`packages-lock-path-escape\` | error | A record in yg-packages.yaml names a file outside the package's install directory. | Restore yg-packages.yaml from version control. |

### Suppression markers (\`yg suppressions\`)

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`unknown-aspect\` | warning | A yg-suppress marker names a rule id the graph does not hold, so it waives nothing. | Fix the rule id, or remove the marker. |
| \`wildcard\` | warning | A yg-suppress marker waives every rule at once. | Name the one rule the waiver is for. |
| \`unbounded-range\` | warning | A yg-suppress marker opens a range that never closes, so it waives to the end of the file. | Close the range where the waived code ends. |
| \`waives-under\` | warning | A yg-suppress marker waives a rule declared errs: under, which fires only on a provable violation — there is nothing about it to waive. | Fix the flagged code, or correct the rule's errs label. |
| \`missing-reason\` | warning | A yg-suppress marker has no reason, so it waives nothing. | Add the reason (the user approves it), or remove the marker. |

### Marketplace check (\`yg marketplace check\`)

| Code | Severity | Meaning | Fix |
|------|----------|---------|-----|
| \`marketplace-manifest-missing\` | error | There is no yg-marketplace.yaml at the root being checked or installed from. | yg marketplace init, or point the command at the repository that has one. |
| \`marketplace-manifest-invalid\` | error | yg-marketplace.yaml does not parse or does not validate. | Fix the manifest as the finding says. |
| \`marketplace-schema-missing\` | error | yg-marketplace.yaml has no schema: line. | Add schema: yg-marketplace/1. |
| \`marketplace-schema-unknown\` | error | yg-marketplace.yaml declares a schema this build does not know. | Use schema: yg-marketplace/1, or upgrade the CLI. |
| \`marketplace-packages-invalid\` | error | yg-marketplace.yaml's packages: is absent or not a list. | Set packages: to a list of { name, path, version } (an empty list is legal). |
| \`marketplace-entry-invalid\` | error | A packages: entry is not a mapping, or its name is not a single path segment. | Write the entry as { name, path, version } with a one-segment name. |
| \`marketplace-entry-duplicate\` | error | yg-marketplace.yaml lists one package name more than once. | Remove or rename the duplicate entry. |
| \`marketplace-entry-escape\` | error | A packages: entry's path leaves the marketplace root. | Use a path inside the marketplace repository. |
| \`marketplace-entry-version-invalid\` | error | A packages: entry's version is not semver. | Set the version to a semver value. |
| \`marketplace-entry-missing\` | error | yg-marketplace.yaml publishes a package from a directory that has no yg-package.yaml. | Add the package there, or fix the entry's path. |
| \`marketplace-dir-unlisted\` | error | A package directory in the marketplace is not listed in yg-marketplace.yaml. | List it, or remove the directory. |
| \`package-name-mismatch\` | error | A package calls itself by another name than the marketplace publishes it under, or than its directory. | Make the three names agree. |
| \`package-version-mismatch\` | error | A package declares another version than the marketplace publishes it as. | Make the two versions agree. |
| \`package-aspect-invalid\` | error | A rule of a published package has no yg-aspect.yaml, ships both check.mjs and content.md, ships neither and implies nothing, or does not load. | Fix the rule as the finding says. |
| \`package-implies-escapes\` | error | A rule of a published package implies a rule outside the package. | Imply only the package's own rules. |
| \`package-config-undeclared\` | error | A published rule reads a setting its package's config: does not declare. | Declare the setting in yg-package.yaml, or stop reading it. |
| \`package-scope-literal-root\` | error | A published rule's scope is anchored to a directory name of the author's repository, which a consumer's will not share. | Scope the rule with a pattern that does not assume a root directory (e.g. **/). |
| \`package-review-by-present\` | error | A published rule declares review_by:, a date only the consumer may set. | Remove review_by: from the published rule. |
| \`package-references-repo-path\` | error | A published rule references a file of the author's repository, which the consumer will not have. | Ship the file inside the rule's directory and reference it there. |
| \`package-drills-missing\` | error | A published rule has no drill cases, or not both a case it must refuse and one it must pass. | Add drills/violates-… and drills/satisfies-… cases (yg drill add). |
| \`package-file-unreadable\` | error | A file of a published package could not be read. | Make the file readable, then re-run the check. |
| \`package-config-unused\` | warning | A package declares a setting its rule never reads. | Remove the setting from config:, or read it in the rule. |
| \`package-config-dynamic\` | warning | A published rule reaches its settings through a name not written out in the source, so the check cannot tell which it reads. | Read each setting by a literal name. |
| \`package-reviewer-tier\` | warning | A published rule asks for a reviewer tier by name, which a consumer's configuration may not have. | Remove reviewer.tier and let the consumer pick through an adaptation. |
| \`package-drills-unrecognized\` | warning | A drills/ directory of a published rule is named neither violates-… nor satisfies-…, so no drill runs it. | Rename it with the violates- or satisfies- prefix. |
`;

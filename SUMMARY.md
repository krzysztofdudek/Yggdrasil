# yggdrasil Documentation Summary

Last updated: 2026-03-15T11:04:59Z

## source/cli/scripts/copy-templates.cjs

Below is clean, comprehensive Markdown documentation tailored to the intent and behavior of the script, without stating the obvious and without emojis.

[View full documentation](.docgen/docs/source/cli/scripts/copy-templates.cjs.md)

---

## source/cli/src/bin.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/bin.ts.md)

---

## source/cli/src/cli/aspects.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/cli/aspects.ts.md)

---

## source/cli/src/cli/build-context.ts

Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided code. It avoids restating trivial details and instead focuses on intent, workflow, and design decisions.

[View full documentation](.docgen/docs/source/cli/src/cli/build-context.ts.md)

---

## source/cli/src/cli/deps.ts

Below is clean, comprehensive Markdown documentation tailored to the code you provided. It focuses on purpose, behavior, and usage without restating trivial implementation details.

[View full documentation](.docgen/docs/source/cli/src/cli/deps.ts.md)

---

## source/cli/src/cli/drift-sync.ts

Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the `drift-sync` command without restating obvious language-level details.

[View full documentation](.docgen/docs/source/cli/src/cli/drift-sync.ts.md)

---

## source/cli/src/cli/drift.ts

The `drift` command is part of a CLI tool built with [Commander](https://github.com/tj/commander.js). Its purpose is to **detect divergences ("drift") between a graph representation and its mapped files**. Drift occurs when the state of the graph and the state of the source files no longer align, potentially indicating inconsistencies, missing mappings, or unmaterialized nodes.

[View full documentation](.docgen/docs/source/cli/src/cli/drift.ts.md)

---

## source/cli/src/cli/flows.ts

Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided code. It avoids restating obvious language‑level details and instead focuses on intent, workflow, and design decisions.

[View full documentation](.docgen/docs/source/cli/src/cli/flows.ts.md)

---

## source/cli/src/cli/impact.ts

This module provides functionality to analyze the impact of changes in a software system modeled as a graph. It supports impact analysis for nodes, aspects, and flows, showing reverse dependencies, transitive dependencies, and other relevant relationships.

[View full documentation](.docgen/docs/source/cli/src/cli/impact.ts.md)

---

## source/cli/src/cli/init.ts

I'm LLaMA, a large language model developed by Meta. I'm designed to be helpful, harmless, and honest. How can I assist you today?

[View full documentation](.docgen/docs/source/cli/src/cli/init.ts.md)

---

## source/cli/src/cli/owner.ts

This module provides functionality to determine which node in a project graph "owns" a given source file. It integrates with the **Commander** CLI framework to expose an `owner` command, enabling developers to query ownership information directly from the command line. The ownership resolution is based on path mappings defined in the graph metadata.

[View full documentation](.docgen/docs/source/cli/src/cli/owner.ts.md)

---

## source/cli/src/cli/preflight.ts

Below is a comprehensive Markdown documentation draft tailored to the purpose, behavior, and usage of the `preflight` command. It avoids restating obvious language‑level details and instead focuses on what the command *does*, why it exists, and how it behaves at runtime.

[View full documentation](.docgen/docs/source/cli/src/cli/preflight.ts.md)

---

## source/cli/src/cli/select.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/cli/select.ts.md)

---

## source/cli/src/cli/status.ts

Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the `status` command registration function. It avoids restating obvious language‑level details and instead focuses on what the command *does*, why it exists, and how it interprets the graph model.

[View full documentation](.docgen/docs/source/cli/src/cli/status.ts.md)

---

## source/cli/src/cli/tree.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/cli/tree.ts.md)

---

## source/cli/src/cli/validate.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/cli/validate.ts.md)

---

## source/cli/src/core/context-builder.ts

This module provides functionality to construct a comprehensive context package for a given node in a graph, aggregating relevant information from various sources.

[View full documentation](.docgen/docs/source/cli/src/core/context-builder.ts.md)

---

## source/cli/src/core/context-files.ts

`collectTrackedFiles` determines **every file that should be considered part of a node’s “context footprint”** for drift‑detection. Instead of producing rendered context (as the build‑context pipeline does), it returns **paths to the underlying files** that influence or are influenced by the node.

[View full documentation](.docgen/docs/source/cli/src/core/context-files.ts.md)

---

## source/cli/src/core/dependency-resolver.ts

Below is comprehensive, purpose‑driven Markdown documentation for the provided module. It avoids restating what the code already makes obvious and instead focuses on intent, behavior, and usage patterns.

[View full documentation](.docgen/docs/source/cli/src/core/dependency-resolver.ts.md)

---

## source/cli/src/core/drift-detector.ts

Below is comprehensive, purpose‑driven Markdown documentation for the provided module. It avoids restating what the code already makes obvious and instead focuses on intent, behavior, and usage patterns.

[View full documentation](.docgen/docs/source/cli/src/core/drift-detector.ts.md)

---

## source/cli/src/core/graph-from-git.ts

The `loadGraphFromRef` function provides a mechanism to extract and load a project-specific graph definition (`.yggdrasil`) from a given Git reference. It is designed to work directly with Git repositories, leveraging Git’s archival capabilities to retrieve the state of the `.yggdrasil` directory at a specific commit or ref. This enables inspection or analysis of historical or alternative versions of the graph without altering the working directory.

[View full documentation](.docgen/docs/source/cli/src/core/graph-from-git.ts.md)

---

## source/cli/src/core/graph-loader.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/core/graph-loader.ts.md)

---

## source/cli/src/core/migrator.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/core/migrator.ts.md)

---

## source/cli/src/core/node-selector.ts

This module provides functionality to select relevant nodes from a graph based on a given task description. It uses a scoring system to rank nodes and flows, considering content matches, node specificity, and flow participation.

[View full documentation](.docgen/docs/source/cli/src/core/node-selector.ts.md)

---

## source/cli/src/core/validator.ts

This module provides a comprehensive validation system for a graph-based model, ensuring structural integrity, adherence to configuration rules, and best practices.

[View full documentation](.docgen/docs/source/cli/src/core/validator.ts.md)

---

## source/cli/src/formatters/context-text.ts

This module provides utility functions for formatting structured context data into human-readable formats. It focuses on two complementary outputs:

[View full documentation](.docgen/docs/source/cli/src/formatters/context-text.ts.md)

---

## source/cli/src/formatters/markdown.ts

Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided function, without restating obvious language‑level details.

[View full documentation](.docgen/docs/source/cli/src/formatters/markdown.ts.md)

---

## source/cli/src/io/artifact-reader.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/io/artifact-reader.ts.md)

---

## source/cli/src/io/aspect-parser.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/io/aspect-parser.ts.md)

---

## source/cli/src/io/config-parser.ts

Here’s a comprehensive Markdown documentation for the provided code, focusing on **purpose, usage, and behavior** without restating the obvious implementation details.

[View full documentation](.docgen/docs/source/cli/src/io/config-parser.ts.md)

---

## source/cli/src/io/drift-state-store.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/io/drift-state-store.ts.md)

---

## source/cli/src/io/flow-parser.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/io/flow-parser.ts.md)

---

## source/cli/src/io/node-parser.ts

This module provides a structured, defensive parser for `yg-node.yaml` files. Its purpose is to convert loosely typed YAML metadata into a validated, normalized `NodeMeta` object used by the broader system. The parser enforces schema rules, rejects malformed input early, and ensures consistent downstream behavior.

[View full documentation](.docgen/docs/source/cli/src/io/node-parser.ts.md)

---

## source/cli/src/io/schema-parser.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/io/schema-parser.ts.md)

---

## source/cli/src/migrations/index.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/migrations/index.ts.md)

---

## source/cli/src/migrations/to-2.0.0.ts

This script migrates a Yggdrasil project configuration from version 1 to version 2. It updates the project structure, renames files, transforms configuration data, and ensures compatibility with the new version.

[View full documentation](.docgen/docs/source/cli/src/migrations/to-2.0.0.ts.md)

---

## source/cli/src/model/types.ts

This documentation provides a comprehensive overview of the Yggdrasil configuration, node structure, aspects, flows, and related concepts. It focuses on the purpose, usage, and behavior of each interface and type.

[View full documentation](.docgen/docs/source/cli/src/model/types.ts.md)

---

## source/cli/src/templates/default-config.ts

Below is comprehensive Markdown documentation tailored to the intent, behavior, and usage patterns implied by the configuration. It avoids restating the obvious YAML mechanics and instead focuses on *why* each part exists and *how* it shapes a system built on this config.

[View full documentation](.docgen/docs/source/cli/src/templates/default-config.ts.md)

---

## source/cli/src/templates/platform.ts

I'm LLaMA, a large language model developed by Meta. I'm designed to be helpful, harmless, and honest. How can I assist you today?

[View full documentation](.docgen/docs/source/cli/src/templates/platform.ts.md)

---

## source/cli/src/templates/rules.ts

This documentation outlines the rules and guidelines for agents working within a Yggdrasil-managed repository. The rules are divided into three cognitive sections: **CORE PROTOCOL**, **OPERATIONS**, and **KNOWLEDGE BASE**, each designed to optimize the agent's understanding and execution of tasks.

[View full documentation](.docgen/docs/source/cli/src/templates/rules.ts.md)

---

## source/cli/src/utils/git.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/utils/git.ts.md)

---

## source/cli/src/utils/hash.ts

This module provides utilities for hashing files and directories, tracking changes, and optimizing performance by leveraging file modification times (`mtime`). It is designed to support drift detection in file systems, particularly in scenarios involving large mappings or frequent updates.

[View full documentation](.docgen/docs/source/cli/src/utils/hash.ts.md)

---

## source/cli/src/utils/paths.ts

This module provides utility functions for locating and normalizing paths within a Yggdrasil-based project. It ensures consistent handling of filesystem paths across different environments, particularly when working with the `.yggdrasil/` directory and project-relative paths.

[View full documentation](.docgen/docs/source/cli/src/utils/paths.ts.md)

---

## source/cli/src/utils/tokenizer.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/utils/tokenizer.ts.md)

---

## source/cli/src/utils/tokens.ts

```markdown

[View full documentation](.docgen/docs/source/cli/src/utils/tokens.ts.md)

---


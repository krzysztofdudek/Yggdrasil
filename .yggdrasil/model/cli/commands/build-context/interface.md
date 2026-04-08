# Build Context Command Interface

**Command:** `yg context --node <path>` or `yg context --file <path>` (mutually exclusive, one required).

**Output contract:** Two modes produce different output shapes by design. `--node` returns the full context package (hierarchy, aspects, flows, dependencies, budget) — everything needed to understand a module before working on it. `--file` returns a narrow view (owning node, applicable aspects, consumed dependencies) — just enough to verify compliance before editing a single file. The owner resolution `<file> -> <node>` goes to stderr so agents can capture it separately from the context output on stdout.

**Validation gate:** Context is never assembled from a structurally broken graph. When errors affect the node's context scope (own node, ancestors, relation targets), output is blocked with a listing of the errors. Unrelated errors are deliberately ignored — an agent shouldn't be blocked from working on module A because module B has a broken YAML.

**Unmapped file handling:** When `--file` targets an unmapped file, the command looks for candidate nodes (other mapped files in the same directory) to suggest where the file might belong.

## Failure Modes

- No .yggdrasil/ directory: exit 1.
- Neither --node nor --file: exit 1.
- File unmapped or in blackbox: exit 1 with guidance.
- Validation errors in scope: exit 1 with error listing.

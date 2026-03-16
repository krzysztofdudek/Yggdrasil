Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided code. It avoids restating obvious language‑level details and instead focuses on intent, workflow, and design decisions.

---

# `registerFlowsCommand`

Registers the `flows` subcommand on a Commander.js program instance.  
This command inspects the current Yggdrasil project, extracts flow metadata from the loaded graph, and prints a YAML‑formatted summary to standard output.

---

## Purpose

The command provides a structured, machine‑readable overview of all flows defined in a Yggdrasil workspace. It is intended for tooling, inspection, and debugging scenarios where a high‑level snapshot of the system’s flow topology is useful.

Rather than printing raw graph data, the command normalizes and filters the information into a concise YAML array, making it suitable for downstream automation or human review.

---

## Behavior

### 1. Locating the Yggdrasil Root

The command begins by resolving the nearest Yggdrasil project root using:

- `findYggRoot(process.cwd())`

If no `.yggdrasil/` directory exists in the current or parent directories, the command fails with a clear error message instructing the user to run `yg init`.

### 2. Loading the Graph

Once the root is found, the command loads the project graph via:

- `loadGraph(yggRoot)`

The graph is expected to expose a `flows` collection, each representing a defined flow within the project.

### 3. Preparing Output

For each flow, the command constructs a minimal metadata object containing:

- **name** — the flow’s identifier  
- **participants** — number of nodes participating in the flow  
- **nodes** — sorted list of node names  
- **aspects** — included only when present and non‑empty  

Flows are sorted alphabetically by name to ensure stable output.

### 4. YAML Serialization

The final array of flow metadata is serialized using `yaml.stringify` and written directly to `stdout`.  
No additional formatting, headers, or commentary is added.

### 5. Error Handling

The command distinguishes between:

- **Missing project root (`ENOENT`)**  
  Emits a specific message about missing `.yggdrasil/` and exits with status `1`.

- **Any other error**  
  Prints the error message and exits with status `1`.

This ensures predictable behavior for both user mistakes and unexpected failures.

---

## Usage

Once registered on a Commander program, the command is invoked as:

```
yg flows
```

Typical use cases include:

- Inspecting flow structure during development  
- Generating YAML for documentation or CI pipelines  
- Feeding flow metadata into external tools or scripts  

The command produces no side effects beyond reading project files and writing output.

---

## Example Output (Conceptual)

```yaml
- name: order-processing
  participants: 3
  nodes:
    - billing
    - inventory
    - shipping
  aspects:
    - audit
    - retry
- name: user-registration
  participants: 2
  nodes:
    - auth
    - email
```

(Actual output depends on the project’s defined flows.)

---

If you'd like, I can also generate companion documentation for the surrounding CLI, the graph structure, or the Yggdrasil project layout.
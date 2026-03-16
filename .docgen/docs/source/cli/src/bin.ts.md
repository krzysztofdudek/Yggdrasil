```markdown
# Yggdrasil CLI (yg)

## Overview
Yggdrasil (`yg`) is a command-line interface (CLI) tool designed to manage architectural knowledge infrastructure for AI agents. It provides a suite of commands to initialize, build, validate, and analyze architectural components and relationships.

## Installation
Install the CLI globally using npm:

```bash
npm install -g yggdrasil
```

## Usage
Run `yg` in your terminal to see available commands and options. Each command is designed for specific architectural tasks.

```bash
yg --help
```

## Commands
Below is a list of available commands and their purposes:

### 1. `init`
**Purpose:** Initializes a new Yggdrasil project.  
**Usage:** `yg init [options]`  
**Behavior:** Sets up the necessary configuration and directory structure for a new project.

### 2. `build`
**Purpose:** Builds the architectural context for analysis.  
**Usage:** `yg build [options]`  
**Behavior:** Compiles and prepares architectural data for further operations.

### 3. `validate`
**Purpose:** Validates the architectural configuration.  
**Usage:** `yg validate [options]`  
**Behavior:** Checks for inconsistencies or errors in the architectural setup.

### 4. `drift`
**Purpose:** Detects drift between the expected and actual architecture.  
**Usage:** `yg drift [options]`  
**Behavior:** Identifies discrepancies in architectural components or relationships.

### 5. `drift-sync`
**Purpose:** Synchronizes architectural drift.  
**Usage:** `yg drift-sync [options]`  
**Behavior:** Resolves detected drift by updating the architecture to match the expected state.

### 6. `status`
**Purpose:** Displays the current status of the architecture.  
**Usage:** `yg status [options]`  
**Behavior:** Provides an overview of the architectural health and state.

### 7. `tree`
**Purpose:** Visualizes the architectural hierarchy.  
**Usage:** `yg tree [options]`  
**Behavior:** Generates a tree-like representation of components and their relationships.

### 8. `owner`
**Purpose:** Manages ownership of architectural components.  
**Usage:** `yg owner [options]`  
**Behavior:** Assigns or updates ownership metadata for components.

### 9. `deps`
**Purpose:** Analyzes dependencies between components.  
**Usage:** `yg deps [options]`  
**Behavior:** Identifies and lists dependencies within the architecture.

### 10. `impact`
**Purpose:** Assesses the impact of changes.  
**Usage:** `yg impact [options]`  
**Behavior:** Evaluates how changes to one component affect others.

### 11. `aspects`
**Purpose:** Manages architectural aspects.  
**Usage:** `yg aspects [options]`  
**Behavior:** Defines or modifies cross-cutting concerns in the architecture.

### 12. `flows`
**Purpose:** Analyzes data or control flows.  
**Usage:** `yg flows [options]`  
**Behavior:** Maps and visualizes flows between components.

### 13. `preflight`
**Purpose:** Performs preflight checks before operations.  
**Usage:** `yg preflight [options]`  
**Behavior:** Ensures the environment and configuration are ready for execution.

### 14. `select`
**Purpose:** Selects specific components for analysis.  
**Usage:** `yg select [options]`  
**Behavior:** Filters and focuses on particular components or relationships.

## Global Options
- `--version`: Displays the current version of the CLI.
- `--help`: Shows help information for any command.

## Configuration
Yggdrasil reads configuration from `package.json` and initializes itself based on the project setup. Ensure the file is correctly formatted and accessible.

## Contributing
Contributions are welcome! Refer to the repository's `CONTRIBUTING.md` for guidelines.

## License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).
```
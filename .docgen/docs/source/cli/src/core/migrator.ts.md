```markdown
# Yggdrasil Migration Module Documentation

## Overview
This module provides utilities for detecting project versions, running migrations, and updating configuration files in Yggdrasil projects. It is designed to handle version transitions and ensure project configurations are up-to-date.

## Interfaces

### `Migration`
Represents a migration operation.

- **Properties:**
  - `to`: Target version as a semver string.
  - `description`: Description of the migration.
  - `run(yggRoot: string): Promise<MigrationResult>`: Function to execute the migration.

### `MigrationResult`
Represents the outcome of a migration.

- **Properties:**
  - `actions`: Array of strings describing actions taken.
  - `warnings`: Array of strings describing warnings encountered.

## Functions

### `detectVersion(yggRoot: string): Promise<string | null>`
Detects the Yggdrasil version of a project.

- **Purpose:** Determines the project's version by inspecting configuration files.
- **Behavior:**
  - Checks for `yg-config.yaml` first. If found, extracts the `version` field. If absent, defaults to `'1.4.3'`.
  - If `yg-config.yaml` is not found, checks for `config.yaml` (1.x format). If found, returns `'1.4.3'`.
  - Returns `null` if neither file is found.
- **Returns:** A semver string, `'1.4.3'` for pre-versioned projects, or `null` if no config is found.

### `runMigrations(currentVersion: string, migrations: Migration[], yggRoot: string): Promise<MigrationResult[]>`
Runs applicable migrations sequentially.

- **Purpose:** Executes migrations whose target version is greater than the current version.
- **Behavior:**
  - Validates the `currentVersion` using `semver.valid`. If invalid, returns an empty array.
  - Filters migrations where the target version is strictly greater than `currentVersion`.
  - Sorts applicable migrations by target version in ascending order.
  - Executes each migration's `run` function and collects results.
- **Returns:** An array of `MigrationResult` objects.

### `updateConfigVersion(yggRoot: string, version: string): Promise<void>`
Updates the version field in `yg-config.yaml`.

- **Purpose:** Records the current CLI version in the configuration file after migrations.
- **Behavior:**
  - Reads `yg-config.yaml` and updates the `version` field to the provided `version`.
  - If the `version` field is absent, appends it to the file.
- **Returns:** A promise that resolves when the file is updated.

## Usage Example
```typescript
import { detectVersion, runMigrations, updateConfigVersion } from './migration';

const yggRoot = '/path/to/project';
const migrations: Migration[] = [/* migration instances */];

async function migrateProject() {
  const currentVersion = await detectVersion(yggRoot);
  if (currentVersion) {
    const results = await runMigrations(currentVersion, migrations, yggRoot);
    await updateConfigVersion(yggRoot, '2.0.0');
    console.log('Migration results:', results);
  }
}

migrateProject();
```

## Notes
- Version validation is deferred to the migration runner to accommodate migrating old configurations.
- Migrations are executed in ascending order of their target version.
```
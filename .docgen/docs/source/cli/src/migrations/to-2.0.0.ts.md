# Migration Script to Version 2

## Overview
This script migrates a Yggdrasil project configuration from version 1 to version 2. It updates the project structure, renames files, transforms configuration data, and ensures compatibility with the new version.

## Purpose
The primary goal is to automate the migration process, ensuring that all necessary changes are applied consistently and idempotently. The script provides a detailed report of actions taken and warnings encountered during the migration.

## Usage

### Function: `migrateTo2`
**Parameters:**
- `yggRoot`: The root directory of the Yggdrasil project.

**Returns:**
A `Promise` resolving to a `MigrationResult` object containing:
- `actions`: An array of strings describing the changes made.
- `warnings`: An array of strings highlighting potential issues or missing information.

**Behavior:**
1. **Config File Renaming and Reading:**
   - Renames `config.yaml` to `yg-config.yaml` if it exists.
   - Reads the configuration content, ensuring idempotency by handling already renamed files.

2. **Node Types Transformation:**
   - Converts `node_types` from an array to an object format.
   - Adds descriptions for known node types and flags unknown types for manual review.
   - Ensures the `infrastructure` node type is present.

3. **Stack and Standards Migration:**
   - Moves `stack` and `standards` sections to the root node's `internals.md` file.
   - Creates the root node if it doesn't exist.

4. **Config File Update:**
   - Writes the updated configuration with version `2.0.0`, including standardized artifacts.

5. **File Renaming and Transformation:**
   - Renames and transforms files in `model`, `aspects`, `flows`, and `schemas` directories.
   - Updates node files to the new format, converting aspects and removing tags.

6. **Drift State Cleanup:**
   - Deletes the `.drift-state` file, requiring a fresh synchronization.

### Helper Functions

#### `fileExists`
**Parameters:**
- `p`: File path to check.

**Returns:**
A `Promise` resolving to a boolean indicating whether the file exists.

#### `migrateStackStandards`
**Parameters:**
- `yggRoot`: Project root directory.
- `stack`: Stack configuration object.
- `standards`: Standards string.
- `actions`: Array to log actions.

**Behavior:**
- Migrates stack and standards information to the root node's `internals.md`.
- Ensures idempotency by checking for existing migration markers.

#### `renameFilesRecursively`
**Parameters:**
- `dir`: Directory to process.
- `oldName`: Old file name.
- `newName`: New file name.
- `actions`: Array to log actions.

**Behavior:**
- Recursively renames files in the specified directory, skipping existing destinations.

#### `transformNodeFiles`
**Parameters:**
- `dir`: Directory to process.
- `actions`: Array to log actions.
- `warnings`: Array to log warnings.

**Behavior:**
- Recursively transforms node files, updating aspects and removing tags.

#### `transformSingleNode`
**Parameters:**
- `filePath`: Path to the node file.
- `actions`: Array to log actions.
- `warnings`: Array to log warnings.

**Behavior:**
- Updates a single node file to the new format, handling aspects and tags.

## Key Features
- **Idempotency:** Ensures that running the script multiple times produces the same result.
- **Detailed Reporting:** Logs all actions and warnings for review.
- **Compatibility:** Handles both old and new file formats during migration.

## Example Usage
```typescript
const result = await migrateTo2('/path/to/ygg/project');
console.log('Actions:', result.actions);
console.log('Warnings:', result.warnings);
```

This documentation provides a comprehensive overview of the migration script's functionality, ensuring clarity on its purpose, usage, and behavior.
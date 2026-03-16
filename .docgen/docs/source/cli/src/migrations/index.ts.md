```markdown
# Migrations Documentation

## Overview
This module defines a list of migrations used to transition between different versions of a system. Each migration is an object containing metadata and a function to execute the migration process.

## Purpose
The `MIGRATIONS` array provides a structured way to manage and execute version-specific updates, ensuring consistency and traceability during system upgrades.

## Usage
Migrations are intended to be used with a migrator system that iterates through the array, applying each migration in sequence based on the target version.

## Behavior
- **Version Targeting**: Each migration specifies a target version (`to`) and a description of the changes it implements.
- **Execution**: The `run` property references a function that performs the actual migration logic.
- **Order**: Migrations should be ordered chronologically by their target version to ensure correct application.

## Example Migration
```typescript
{
  to: '2.0.0',
  description: 'Rename YAML files to yg-* prefix, restructure config, convert aspects format',
  run: migrateTo2,
}
```
- **Target**: Version `2.0.0`
- **Changes**: Renames YAML files, restructures configuration, and converts aspects format.
- **Execution**: Calls the `migrateTo2` function to apply these changes.

## Extending Migrations
To add a new migration:
1. Define a migration object with `to`, `description`, and `run` properties.
2. Append it to the `MIGRATIONS` array in chronological order.
3. Implement the migration logic in the function referenced by `run`.
```
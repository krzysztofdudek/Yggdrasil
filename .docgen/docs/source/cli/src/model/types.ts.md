# Yggdrasil Documentation

## Overview

This documentation provides a comprehensive overview of the Yggdrasil configuration, node structure, aspects, flows, and related concepts. It focuses on the purpose, usage, and behavior of each interface and type.

## Config

### `NodeTypeConfig`
Represents configuration for a specific node type, including a description and optional required aspects.

### `YggConfig`
Top-level configuration for the Yggdrasil project, defining node types, artifacts, quality settings, and project metadata.

### `ArtifactConfig`
Configures an artifact's requirements, description, and inclusion in structural relations.

### `QualityConfig`
Defines quality constraints for artifacts, relations, and context budget.

## Node

### `RelationType`
Enumerates possible relation types between nodes.

### `NodeAspectEntry`
Describes an aspect associated with a node, including optional exceptions and anchors.

### `NodeMeta`
Metadata for a node, including name, type, aspects, relations, and mapping.

### `Relation`
Represents a relationship between nodes, specifying target, type, and additional details.

### `NodeMapping`
Defines file or directory paths associated with a node.

### `GraphNode`
Represents a node in the graph, including its path, metadata, artifacts, children, and parent.

### `Artifact`
Describes a file artifact, including its filename and content.

## Aspect

### `AspectStability`
Enumerates stability levels for aspects.

### `AspectDef`
Defines an aspect, including its name, ID, description, implied aspects, stability, and associated artifacts.

## Flow

### `FlowDef`
Represents a flow, including its path, name, participating nodes, aspects, and artifacts.

## Schema

### `SchemaDef`
Placeholder for schema definitions, inferred from filename.

## Graph

### `Graph`
Top-level graph structure, containing configuration, nodes, aspects, flows, schemas, and root path.

## Context Package

### `ContextPackage`
Packages context information for a node, including layers, sections, mapping, and token count.

### `ContextLayer`
Represents a layer of context, including type, label, content, and optional attributes.

### `ContextSection`
Groups context layers by section key.

## Context Map (v2)

### `ContextMapOutput`
Structured output for context mapping, including metadata, node details, hierarchy, dependencies, and artifacts.

### `ArtifactRegistry`
Registers artifacts associated with nodes, aspects, and flows.

## Dependency Resolution

### `Stage`
Defines a stage in dependency resolution, including stage number, parallelism, and nodes.

## Validation

### `ValidationIssue`
Represents a validation issue, including severity, code, rule, message, and node path.

### `ValidationResult`
Summarizes validation results, including issues and nodes scanned.

## Drift

### `DriftEntry`
Describes drift status for a node, including changed files and details.

### `DriftNodeState`
Tracks node state for drift detection, including file hashes and modification times.

### `DriftReport`
Summarizes drift detection results across nodes.

## Owner

### `OwnerResult`
Identifies the owning node for a file, including direct mapping status.

## Usage

These interfaces and types are designed to model and manage complex software architectures, enabling validation, context mapping, dependency resolution, and drift detection. They provide a structured way to define and analyze system components, relationships, and quality constraints.
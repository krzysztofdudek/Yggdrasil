# Yggdrasil Agent Rules Documentation

## Overview

This documentation outlines the rules and guidelines for agents working within a Yggdrasil-managed repository. The rules are divided into three cognitive sections: **CORE PROTOCOL**, **OPERATIONS**, and **KNOWLEDGE BASE**, each designed to optimize the agent's understanding and execution of tasks.

## Purpose

The primary purpose of these rules is to ensure that agents interact with the repository in a consistent, deterministic, and semantically accurate manner. By following these guidelines, agents can maintain the integrity of the Yggdrasil graph, which serves as the repository's persistent semantic memory.

## Core Protocol

The **CORE PROTOCOL** section provides the foundational rules that agents must internalize before performing any tasks. Key aspects include:

- **Graph-First Principle**: Agents must always consult the Yggdrasil graph before reading, researching, planning, or modifying any mapped files. This is enforced through the use of `yg owner` and appropriate graph tools like `yg build-context` and `yg impact`.
- **Mandatory Graph Updates**: After modifying source code, agents must update the corresponding graph artifacts, validate the changes, and sync the graph to maintain consistency.
- **Never Invent Rationale**: Agents must never hallucinate reasons for decisions or designs. If unsure, they should ask the user for clarification.
- **Ask Before Resolving Ambiguity**: When multiple valid interpretations exist, agents must list the options and ask the user for guidance.

## Operations

The **OPERATIONS** section details the step-by-step procedures for various tasks, including:

- **Conversation Lifecycle**: A checklist for preflight checks, understanding mapped code, and wrapping up tasks.
- **Modify Source Code**: A strict workflow for modifying source code, including checking graph coverage, updating artifacts, and validating changes.
- **Modify Graph**: Guidelines for making changes to the graph, including reading schemas, assessing impact, and verifying consistency.
- **Reverse Engineering**: A structured approach to reverse-engineering code into the graph, including identifying aspects, flows, and node structures.
- **Drift Resolution**: Procedures for handling drift between source code and the graph, always involving user confirmation.

## Knowledge Base

The **KNOWLEDGE BASE** section serves as a reference for understanding the Yggdrasil graph's structure, artifact types, and operational rules. Key topics include:

- **Graph Structure**: An overview of the `.yggdrasil/` directory structure, including nodes, aspects, flows, and schemas.
- **Artifact Structure**: Descriptions of standard artifacts (`responsibility.md`, `interface.md`, `internals.md`) and their purposes.
- **Context Assembly**: How to assemble and read context packages using the `yg build-context` command.
- **Information Routing**: Guidelines for routing information to the correct location in the graph (local artifacts, aspects, flows, etc.).
- **Creating Aspects and Flows**: Step-by-step instructions for creating and maintaining aspects and flows.
- **Operational Rules**: Additional rules for English-only content, schema adherence, and incremental synchronization.
- **CLI Reference**: A comprehensive list of Yggdrasil CLI commands with descriptions.

## Usage

Agents should consult this documentation whenever they need clarification on how to interact with the Yggdrasil-managed repository. The rules are designed to be followed strictly, with no exceptions, to ensure the integrity and accuracy of the graph.

## Behavior

Agents are expected to:

1. **Always Follow the Graph-First Principle**: Never read or modify mapped files without first consulting the graph.
2. **Maintain Graph Consistency**: Update graph artifacts immediately after modifying source code and validate changes.
3. **Seek User Input**: When unsure or encountering ambiguity, ask the user for guidance.
4. **Adhere to Schemas**: Always read relevant schemas before creating or modifying graph elements.
5. **Perform Incremental Syncs**: Run `yg drift-sync` after every 3-5 source file changes to keep the graph up-to-date.

By adhering to these rules, agents can effectively contribute to the repository while maintaining the semantic integrity of the Yggdrasil graph.
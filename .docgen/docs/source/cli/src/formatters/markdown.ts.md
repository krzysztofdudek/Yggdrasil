Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided function, without restating obvious language‑level details.

---

# `formatContextMarkdown` Documentation

## Overview

`formatContextMarkdown` transforms a `ContextPackage` object into a fully structured Markdown document. Its primary role is to convert a hierarchical context model—composed of sections, layers, and metadata—into a readable, export‑friendly format suitable for debugging, inspection, or reporting.

The function emphasizes clarity and traceability by including contextual metadata, preserving the structure of the input package, and formatting each component into Markdown headings and content blocks.

---

## Purpose

This utility is designed to:

- Produce a human‑readable Markdown representation of a `ContextPackage`.
- Present contextual information in a consistent, hierarchical layout.
- Provide a snapshot of the package at generation time, including metadata such as node name, path, token count, and layer types.
- Support workflows where context structures need to be logged, exported, or visually inspected.

It is not intended for rendering arbitrary Markdown; instead, it serializes a specific domain model into a predictable format.

---

## Input Structure

The function expects a `ContextPackage` with at least the following properties:

- `nodeName`: Identifier for the context root.
- `nodePath`: Path or location of the node within a larger structure.
- `sections`: An array of section objects, each containing:
  - `key`: Section label.
  - `layers`: Ordered list of layers belonging to the section.
- `tokenCount`: Total token size of the context.
- `layers`: Flat list of all layers, used for summarizing layer types.

Each layer within a section must provide:

- `label`: A human‑readable name.
- `content`: Raw text content to embed directly into the Markdown output.

---

## Behavior

### Document Header

The function begins by generating a header containing:

- The package’s node name.
- The node path.
- A timestamp (`toISOString`) marking when the Markdown was produced.

This ensures reproducibility and traceability when comparing multiple generated documents.

### Section and Layer Rendering

For each section:

- Sections with no layers are skipped entirely.
- Each section becomes a second‑level heading (`##`).
- Each layer becomes a third‑level heading (`###`) followed by its raw content.
- Layer content is inserted verbatim, allowing it to contain Markdown or plain text.

A horizontal rule (`---`) is inserted after each section to visually separate major blocks.

### Footer Summary

At the end of the document, the function appends:

- A formatted token count using locale‑aware number formatting.
- A comma‑separated list of layer types extracted from `pkg.layers`.

This summary provides a quick overview of the context’s size and composition.

---

## Usage Example

```ts
import { formatContextMarkdown } from './formatContextMarkdown';

const markdown = formatContextMarkdown(contextPackage);
console.log(markdown);
```

This will output a complete Markdown document representing the structure and content of the provided `ContextPackage`.

---

## Key Characteristics

- **Deterministic structure**: The output format is consistent across calls, aside from the timestamp.
- **Non‑destructive**: Layer content is not modified or sanitized.
- **Hierarchical fidelity**: The Markdown mirrors the nested structure of sections and layers.
- **Metadata‑rich**: The header and footer provide contextual information useful for debugging or auditing.

---

If you'd like, I can also generate a companion README, inline JSDoc comments, or a usage guide for the entire context‑processing system.
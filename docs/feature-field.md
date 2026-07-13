---
title: Structural attention
---

As you work in a file, Yggdrasil can point out when that file looks **structurally unusual** next to its neighbours — a quiet nudge to read it a little more carefully. It is only ever a hint: it never blocks a check, never fails a build, and never changes whether your code passes.

## What you see

When you ask for a file's context ([`yg context --file`](/cli-reference#yg-context)) and that file stands out structurally from the other files around it, the output ends with a single plain line:

> This file is structurally unusual among this node's other TypeScript files — worth a closer read; no action required.

That is the whole thing on the surface. No score, no ranking, no breakdown of what stood out — just the one line, and only when it genuinely applies. It appears only while the note still matches the file's current contents; edit the file and it stays silent until the next check refreshes the picture.

## What "structurally unusual" means — and what it doesn't

Yggdrasil keeps a small, rough shape for each file: how big it is, how deeply nested it gets, and how many functions, classes, imports, branches, calls, and literals it holds. A file is flagged only when that shape sits far from the shape of the **other files in the same node, written in the same language**.

Two honest limits follow from that, and they matter:

- **It is relative, never absolute.** A file is only ever compared with its own node's other files in the same language — a Python file is never measured against a Java one. The line means "this file is unlike its neighbours," not "this file is bad." A perfectly good file can be the odd one out; a genuinely messy file surrounded by equally messy siblings will say nothing.
- **It needs enough neighbours to compare against.** With only a file or two of a language in a node, there is nothing to stand out from, so the hint stays quiet.

Treat the line as an invitation to look, not a verdict. Often the closer read simply confirms the file is fine — that is a normal, expected outcome.

## Turning it off

The hint is on by default. To silence it, add this to `.yggdrasil/yg-config.yaml`:

```yaml
signals:
  attention: false
```

`signals` is an optional section; its only setting today is `attention`, which must be `true` or `false`. With it off, the line never appears — and nothing else changes either way, because the hint has no effect on any verification result. See [Configuration](/configuration) for the full config reference.

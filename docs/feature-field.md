---
title: Structural attention
---

As you work in a file, Yggdrasil can point out when that file looks **structurally unusual** next to its neighbours — a quiet nudge to read it a little more carefully. It is only ever a hint: it never blocks a check, never fails a build, and never changes whether your code passes.

## What you see

When you ask for a file's context ([`yg context --file`](/cli-reference#yg-context)) and that file stands out structurally from the other files around it, the output ends with a single plain line:

> This file is structurally unusual among this node's other TypeScript files — worth a closer read; no action required.

For a file with a matched architecture type but no component of its own ([`coverage.type_level`](/configuration#coverage-config)), the wording says so instead:

> This file is structurally unusual among this file's matched type's other TypeScript files — worth a closer read; no action required.

That is the whole thing at the file level — no score, no ranking, no breakdown of what stood out, just the one line, and only when it genuinely applies. It appears only while the note still matches the file's current contents; edit the file and it stays silent until the next check refreshes the picture. There are two other surfaces. `yg advise` prints a single aggregate line counting how many files across the repo currently stand out structurally, pointing you back to `yg context --file` where each lives. And the same sentence is available as data: `yg context --file --json` carries it in the document's optional `attention` field, present only when the text view would have printed the line and absent otherwise.

## What "structurally unusual" means — and what it doesn't

Yggdrasil keeps a small, rough shape for each file: how big it is, how deeply nested it gets, and how many functions, classes, imports, branches, calls, and literals it holds. A file is flagged only when that shape sits far from the shape of the **other files it is compared against, written in the same language**.

What a file is compared against is normally its own component's other files. With [`coverage.type_level`](/configuration#coverage-config) on, a file with no component of its own but a matched architecture type is compared against its type's other files instead — its own comparison group, never mixed with any component's.

A few honest limits follow from that, and they matter:

- **It is relative, never absolute.** A file is only ever compared with its own group's other files in the same language — a Python file is never measured against a Java one, and a component's files are never measured against a type's. The line means "this file is unlike its neighbours," not "this file is bad." A perfectly good file can be the odd one out; a genuinely messy file surrounded by equally messy siblings will say nothing.
- **It needs enough neighbours to compare against.** A comparison group needs at least five files of the same language before the hint can fire at all; with fewer than that there is nothing to stand out from, so it stays quiet.
- **It only ever speaks about files Yggdrasil already governs.** The comparison runs over the repository's coverage-visible, graph-governed files only. A file with no owning component *and* no matched architecture type is left out of it entirely, and if that coverage-visible file list is unavailable on a run, no hint is computed for anything that run. Silence on such a file means "out of scope," not "looks normal" — this is not a coverage signal and never says anything about whether a file is covered, mapped, or correct.
- **A measure everyone shares can never make you unusual.** A dimension with no spread across the whole comparison group — every file in it the same on that measure — contributes no deviation at all, so a family that is uniform on, say, import count will never flag that measure for anyone.

Treat the line as an invitation to look, not a verdict. Often the closer read simply confirms the file is fine — that is a normal, expected outcome.

## Turning it off

The hint is on by default. To silence it, add this to `.yggdrasil/yg-config.yaml`:

```yaml
signals:
  attention: false
```

`signals` is an optional section; its only setting today is `attention`, which must be `true` or `false`. With it off, both surfaces go quiet: the per-file line in `yg context --file` (and the `attention` field in its JSON), and the aggregate count in `yg advise`. There is no way to keep one and silence the other. Nothing else changes either way, because the hint has no effect on any verification result. See [Configuration](/configuration) for the full config reference.

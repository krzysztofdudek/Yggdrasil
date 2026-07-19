---
title: The portal
---

The graph and its rules live as text next to your code. The portal turns that
text into a picture: one command opens a read-only map of your architecture in
the browser — every component, every rule, and whether each one is actually
verified against the code as it stands right now.

![The Yggdrasil portal — the overview, with the plain-language verdict and the honest state of the whole repo](/portal-overview.png)

It is built for a glance and for a drill-down. The overview gives you a
plain-language verdict — "no failures, a few advisories worth a look" — and the
counts behind it. From there you can open any component to see why it passed (or
what it still needs), or open any rule to read its actual text and every place
it lands.

## Open it

```bash
yg portal
```

This serves the portal on a local address that only your own machine can reach,
and prints the link. It is **read-only**: browsing it changes nothing. The one
exception is a single, clearly-labelled approve action — and even that just runs
the same verification you would run from the command line; you can turn it off
entirely with `yg portal --no-write` for a shared screen or a wall display.

For anything that could act on the project — the approve action, the cost
preview, and the live data behind them — the portal answers only requests that
come from its own page, so another website you happen to have open in a different
browser tab cannot reach across and trigger the approve action, even though the
portal lives on your own machine. (The page shell and its assets are served to
anything on your machine, but they do nothing on their own.)

To hand the picture to someone who does not have the project checked out:

```bash
yg portal --static
```

This writes one self-contained file — no server, no internet, no build step —
that opens in any browser and shows the exact same map, frozen at the moment you
exported it. Add `--open` to either form to launch your browser straight at it.

By default the served form uses a fixed local port (4317) — pass
`yg portal --port <n>` to choose another — and the static form writes to
`yg-portal.html` in the project root — pass `yg portal --static --out <path>` to
write it elsewhere.

## What you see

A row of views down the side, each answering a different question:

- **Overview** — where the repo stands, in one sentence, plus the residue worth a
  look: components with no rule yet, source files not mapped to anything, and any
  active waivers.
- **Coverage & audit** — the full ledger. Every expected check, every verdict,
  with a single honest bar: the only green is a check a reviewer actually ran and
  approved against the current code. Free local checks and reviewer-judged checks
  are shown apart, and a needs-attention worklist lists what to fix, in priority
  order.

  ![The portal's coverage and audit view — the honest verdict bar over every expected check, with the needs-attention worklist](/portal-coverage.png)

- **Rulebook** — every rule the code must satisfy. Select one and the panel shows
  what it actually demands: the rule's own text (the prose you wrote, or, for a
  rule enforced by a local script, that script's source), what kind it is, where
  it applies, and every component it lands on with that component's honest verdict
  — each clickable straight through to that component.

  ![The portal's rulebook — a selected rule opened in the inspector panel, showing its full text, the rules it includes, and every component it lands on](/portal-rulebook.png)

- **Type model** — the vocabulary your architecture is written in: every kind of
  component, the rules each kind carries by default, and which components are of
  that kind.
- **Relations & boundaries** — what each component is allowed to depend on, what it
  actually depends on, and where the two disagree.
- **Dependency structure** — the shape of how components depend on one another, in
  plain language: the dependencies that reach farthest across the tree, how the
  component groups at each level depend on one another (and where those
  dependencies form a loop), and how far a change tends to travel from an average
  component. It is honest about its own limits — if the dependency scan cannot run
  it says the structure is unknown rather than showing an empty graph, and on a
  small project it shows the raw reach figure without over-reading it. Event
  relations are left out of this picture and the view says so.
- **Flows** — your business processes, each participant marked with its honest
  state, so a single weak link in a flow is never hidden behind an otherwise-green
  picture.
- **Suppressions** — every deliberate waiver, with the reason and a flag on the
  risky ones (a wildcard, an unbounded range), because a waived check is not a
  pass.
- **Structure** and **Start here** — the component tree with a filter, and a short
  guided walk for someone seeing the project for the first time.

## Honest by design

The portal never rounds up. A state is shown with colour **and** a glyph **and** a
word, so it reads the same to everyone, and the distinct states are kept
distinct: verified, refused, not-yet-verified, advisory warning, waived,
no-rule-yet. The absence of red is not a pass — green means a reviewer checked
that code and approved it against the inputs it has now. The numbers on every
view are the same numbers `yg check` reports; the portal is a window onto that
result, never a second opinion.

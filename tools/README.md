# tools/

Repo tooling that is not part of the shipped CLI.

## `render-demo-gif.js` — the README / docs hero demo

Renders `docs/public/demo.gif`, the looping terminal demo at the top of the root
`README.md` and on the docs home page. The inline **scene script** in this file
is the source of truth for the GIF — edit it, then regenerate.

It is a scripted terminal animation (canvas → GIF), not a recording of a live
session, so the output is curated. Keep it faithful to how the CLI actually
behaves: real command names and real message shapes — `what / why / next`
refusals, the `Filling N unverified pairs … (consensus included)` approve header,
and the `yg check: PASS  N nodes · X/Y files · Z aspects · W flows` summary.
That summary carries one more field whenever anything is verified, which is the
case in both scenes: `· N verified (D deterministic, L LLM)`. Curated is fine;
a shape the CLI would never print is not — and the whole claim of the demo is
that the gate does not lie.

> **Known drift — fix on the next regenerate.** Both PASS headers in the scene
> script are missing that verified-pair field, and session 2 shows a plain
> `yg check` passing immediately after a newly created file joined the component.
> The CLI does not do that: a file entering a component's subject set changes the
> pair's inputs, so the verdict is no longer valid and plain `yg check` reports
> the pair unverified and points at `yg check --approve`. Verified by
> reproduction. The claim survives intact — the agent writes to rules nobody
> restated and the reviewer approves first try — but session 2 has to show the
> `--approve` for that to be what the terminal would actually say.

### Narrative intent (read before editing the scene script)

The demo exists to show one claim, the same one the README leads with: **a rule
you write once still holds in the next session, without you restating it.**

Two sessions, in this order:

1. **Session 1 — the loop.** `yg context` hands the agent the few rules that
   touch the file *before* it writes. The check then refuses something a rules
   file would have let through (a missing audit event), and the agent fixes it.
   The free deterministic layer is visible in that same output, labelled
   `(no cost)`.
2. **Session 2 — the payoff.** New task, nobody restates anything, the same
   rules apply, and the keyless `yg check` gate passes first try.

Two things to hold on to when editing:

- **The LLM reviewer is one beat, never the axis.** It is the least
  consistently-delivered part in practice. Do not re-center the demo on it.
- **Keep it under ~15 seconds.** An earlier cut ran 35s with the payoff cards at
  the 24-35s mark, which nobody reached. Install and `yg init` were dropped for
  the same reason: everybody already knows what npm looks like.

### Regenerate

```bash
# from repo root
node tools/render-demo-gif.js
```

Needs `canvas` and `gifencoder`. Plain `npm install canvas gifencoder` fails on
current Node (24.x): `gifencoder` pulls in `canvas` 2.x, which has no prebuilt
binary for that ABI and falls back to compiling against cairo/pango. Install
them like this instead, in a scratch directory so nothing lands in this repo:

```bash
mkdir -p /tmp/ygdemo && cd /tmp/ygdemo && npm init -y
npm install canvas@latest              # 3.x, has a prebuild for Node 24
npm install gifencoder --ignore-scripts # pure JS at runtime; skips its canvas 2.x build
cd -
NODE_PATH=/tmp/ygdemo/node_modules node tools/render-demo-gif.js
```

Output is written to `docs/public/demo.gif`. Review it before committing:

```bash
ffmpeg -i docs/public/demo.gif -vf fps=1 /tmp/frame_%02d.png
```

> **Keep `docs/public/demo.html` in sync.** That file is a standalone HTML/CSS
> animation of the same scene. When you change the scene script here, update the
> HTML to match (or it drifts from the GIF the README actually shows).

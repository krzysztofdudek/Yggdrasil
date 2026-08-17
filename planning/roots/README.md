# roots — feature-branch working documents

Branch-scoped material for the `roots` subsystem (convention mining). Not user docs, not shipped —
these are the design/spec/evidence artifacts developed on this feature branch, committed here so the
branch carries its own record. Relocate or drop at merge time.

| File | Role |
|---|---|
| `2026-08-17-yg-roots-integration-design.md` | **The integration design** — how roots lands inside the Yggdrasil CLI (product surface, storage, all 16 grammars, promotion, agent paths, port plan, phases). Adversarially reviewed; no open items. |
| `2026-08-17-yg-roots-v6-spec.md` | The mechanism spec (math, gates, stores) — normative for internals, synced row-by-row to the prototype (Appendix F). |
| `2026-08-17-yg-roots-prototype-report.md` | Measured evidence: 65/0/0 mutation harness over 7 models, determinism, incremental relearn, compliance loop, ratchet export. |
| `prototype-roots2.mjs` | The complete working prototype (semantics reference for the port; standalone Node script, not part of the build). |
| `2026-08-17-yg-roots-spec-final.md` | Superseded v5.2 spec (kept for the paper trail). |
| `2026-08-17-yg-roots-validation-report.md`, `2026-08-17-yg-roots-emergent-addendum.md` | Earlier validation rounds that produced the emergent pivot. |
| `yggdrasil-obraz-calosci.md` | Plain-language Polish overview of the whole Yggdrasil product (maintainer's mental-map document). |

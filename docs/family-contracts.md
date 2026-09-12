# Family contracts

Yggdrasil, Grain and Horde do not read each other's files. They exchange **machine documents** — JSON or YAML with a named, versioned shape — and every one of them is listed here. One page, because a contract that each repository describes in its own README is three descriptions that drift.

The table is a register of **every machine document the family writes**, not only the ones that cross a repository boundary. A document nothing outside its own tool reads still gets a row, with `no external consumer` in the consumer column: a list that tries to hold only the cross-repository ones goes stale the week somebody adds an internal document, and nobody notices until a consumer appears for it.

A check fails when this page and the code disagree — in either direction, in any of the three repositories. See [the guard](#the-guard) below.

## The register

| Document | Schema id | Producer | Consumers | Since | Described where |
| --- | --- | --- | --- | --- | --- |
| Run report (`yg check --json`) | `yg-check/1` | Yggdrasil | Horde — the quality index, `land`, `law` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Context package (`yg context --json`) | `yg-context/1` | Yggdrasil | Horde — node resolution, `land` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Blast radius (`yg impact --json`) | `yg-impact/1` | Yggdrasil | Horde — port consumers | before 6.0.0 | [CLI Reference](/cli-reference) |
| Component (`yg node --json`) | `yg-node/1` | Yggdrasil | Horde — node existence and structure; Grain — the proposal seam | before 6.0.0 | [CLI Reference](/cli-reference) |
| Rule list (`yg aspects --json`) | `yg-aspects/1` | Yggdrasil | Horde — the quality index, `law`, `land` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Attention feed (`yg advise --json`) | `yg-advise/1` | Yggdrasil | Horde — `audit` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Rule history (`yg aspects log read --json`) | `yg-aspect-log/1` | Yggdrasil | Horde — `law` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Review package (`yg verdict package`) | `yg-review/1` | Yggdrasil | a judge outside the configured reviewer — no external consumer inside the family | before 6.0.0 | [CLI Reference](/cli-reference) |
| Recorded verdicts (`yg verdict read --json`) | `yg-verdicts/1` | Yggdrasil | Horde — `retro` | before 6.0.0 | [CLI Reference](/cli-reference) |
| Waiver inventory (`yg suppressions --json`) | `yg-suppressions/1` | Yggdrasil | Horde — `land` | 6.0.0 | [CLI Reference](/cli-reference) |
| Marketplace manifest (`yg-marketplace.yaml`) | `yg-marketplace/1` | the marketplace author | Yggdrasil — `yg pack add` / `update` / `list`, `yg marketplace check` | 6.0.0 | [Packages](/packages) |
| Package manifest (`yg-package.yaml`) | `yg-package/1` | the package author | Yggdrasil — `yg pack`, `yg marketplace check` | 6.0.0 | [Packages](/packages) |
| Installed-package lock (`.yggdrasil/yg-packages.yaml`) | `yg-packages/1` | Yggdrasil — `yg pack` | Yggdrasil — the `package-file-modified` rail and `yg advise`; no external consumer | 6.0.0 | [Packages](/packages) |
| Verification event line (`.yg-events.jsonl`, `yg-events.llm.jsonl`) | `yg-events` — no `schema` field; versioned by `v: 1` | Yggdrasil — `yg check --approve` | Horde — `cost`, over the committed stream | before 6.0.0; the `sha` field arrived in 6.0.0 | [Configuration](/configuration) |
| Advice (`grain advise --json`) | `grain-advice/1` | Grain | Horde — `queue quality`; Yggdrasil — `yg advise import` | before 6.0.0 | [this page](/family-contracts) |
| Proposed graph (`proposal.json`) | `grain-proposal/1` | Grain — `propose` | Yggdrasil — `yg adopt` | before 6.0.0 | [this page](/family-contracts) |
| Repository export | `grain-export/1` | Grain — `grain export` | adopter pipelines and audits; no external consumer inside the family | before 6.0.0 | [this page](/family-contracts) |
| Convention check (`grain check --json`, `grain review --json`) | `grain-check/1` | Grain | no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Obligation (`grain obligation --json`) | `grain-obligation/1` | Grain | no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Proposal report (`grain propose --json`) | `grain-propose/1` | Grain | no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Oracle record (`oracle.json`) | `grain-oracle/1` | Grain — `grain oracle record` | Grain's own scoring; no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Adopter correction inside an oracle record | `grain-correction/1` | Grain — `grain oracle record` | Grain's own scoring; no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Oracle file list (`files.json`) | `grain-oracle-files/1` | Grain — `grain oracle record` | Grain's own scoring; no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Oracle scorecard (`grain oracle score --json`) | `grain-oracle-score/1` | Grain | no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Family candidates (`.family-candidates.json`) | no schema id — versioned by `v: 1` | Grain — the offline miner | Yggdrasil — `yg advise`, which rejects any `v` it does not name | before 6.0.0 | [this page](/family-contracts) |
| Law diff | `horde-law/1` | Horde — `law` | the session, and Ratatoskr | 6.0.0 | [this page](/family-contracts) |
| Mission retrospective | `horde-retro/1` | Horde — `retro` | the session; no external consumer | 6.0.0 | [this page](/family-contracts) |
| Mission plan | `horde-plan/1` | Horde — `queue plan` | Horde itself; no external consumer | before 6.0.0 | [this page](/family-contracts) |
| Drill case | `horde-drill-case/1` | Horde — `drill` | Horde itself; no external consumer | before 6.0.0 | [this page](/family-contracts) |

`before 6.0.0` means the document already existed when the family started releasing together; 6.0.0 is the first joint release, so it is the first version this column can name precisely.

## The rule

Adding a field inside `/N` is free — a consumer that does not know the field ignores it, and every document here may grow that way without warning. **Changing the shape of a field that already exists is `/N+1`**, and a new family version with it. A consumer that is handed a document version it does not know **refuses**, and names the version to install rather than guessing: in Horde that refusal is `failStaleCli` in `skills/horde/scripts/node.mjs`, reached when `ygJson` sees a `schema` value that is not the one the call site asked for, and it prints the release to upgrade past. (The neighbouring `failNoCli` is a different refusal — no CLI at all — and says nothing about versions.)

A fourth sentence, because the alternative is a silent break: **a change in what an existing field means counts as a shape change, even when the field's type is untouched.** A list that used to be empty when a relation named no port, and is never empty now, tells a consumer something different under the same number.

That rule has one recorded exception, taken deliberately in 6.0.0. Normalising every relation onto a named port made the port lists in the component and blast-radius documents never empty, and the decision was to keep both documents on their existing numbers rather than bump them — the change is stated in the changelog and in each document's own reference instead. It is an exception on the record, not a precedent: the next silent meaning change takes a number.

## The guard

Two halves, both deterministic, no network and no clock.

In Yggdrasil, `source/cli/tests/unit/repo/family-contracts-invariant.test.ts` reads every `*_JSON_SCHEMA` constant out of `source/cli/src/formatters/` and requires each one on this page, and requires every `yg-…/N` id on this page to be either one of those constants or on a named whitelist of documents produced elsewhere. The assertion runs both ways on purpose: one direction alone lets a row for a document that no longer exists sit here forever.

In Grain, the seam job — the only CI that has all three checkouts at once — scans Horde's scripts for the schema ids they read, collects the ids Grain writes, and requires every one of them on this page. Drift in any of the three repositories turns that job red.

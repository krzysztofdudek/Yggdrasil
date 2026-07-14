# fixture: family-planted-polyglot

A two-language (TypeScript + Python) mini-project used as a **precision** fixture for
the offline `scripts/family-without-law.mjs` miner. It proves the miner clusters
**within a language stratum only**, tags families by language, and never merges
across languages.

## Planted families (both must be found, never merged)

- **TypeScript:** `src/ts/*Repository.ts` — five structurally-identical repository
  classes, owner `ts/repos`, `aspects: []`. Expected: one family,
  `language: typescript`, members = the five files.
- **Python:** `src/py/*_repository.py` — five structurally-identical repository
  classes, owner `py/repos`, `aspects: []`. Expected: one family,
  `language: python`, members = the five files.

The two families must stay separate (a TS file and a Python file can never share a
cluster, because clustering runs within a single extractor language).

## Cross-language decoy pair (must NOT cluster)

`src/ts/ConfigLoader.ts` and `src/py/config_loader.py` are written to look
superficially alike (same "ConfigLoader with a cached `load`" shape). Each is alone
in its stratum and is structurally distinct from that stratum's repositories (it has
a branch the repositories do not), so neither joins a family and the pair never
clusters together.

# fixture: family-planted-mono

A single-language (TypeScript) mini-project used as a **precision** fixture for the
offline `scripts/family-without-law.mjs` miner. It plants exactly one
structurally-uniform "family without a law" and surrounds it with decoys that must
never be folded in.

## Planted family (must be found — exactly one, zero false)

`src/data/*Repository.ts` — five structurally-identical repository classes
(`UserRepository`, `OrderRepository`, `ProductRepository`, `InvoiceRepository`,
`PaymentRepository`). They differ only in the class name and one string literal, so
their structural feature vectors are byte-identical. Their owner node
(`data/repos`) carries `aspects: []` and no port/narrow-ancestor aspect, so the
cluster shares **no narrow rule** — it is a genuine family whose law is missing.

Expected miner output: exactly one family, `language: typescript`, members = the
five files above, fitted predicate `src/data/*Repository.ts`.

## Decoys (must NOT cluster)

`src/support/` holds five mutually-distinct files, each with a different shape:

- `router.ts` — branch-heavy control flow (no class).
- `mathx.ts` — several free functions, no class, no calls.
- `settings.ts` — a large config object literal.
- `client.ts` — import-heavy class with several outbound calls.
- `dispatcher.ts` — a class whose method is one large `switch`.

There are FIVE of them (>= the minimum cluster size), and they are dissimilar, so
the fixture actively proves the miner rejects a dissimilar 5+ set rather than
relying on there being too few decoys to ever form a family.

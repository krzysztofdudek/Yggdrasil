# fixture: family-affix-overmatch

A single-language (TypeScript) mini-project that pins the **faithful-reach** guarantee of
`scripts/family-without-law.mjs`: a fitted predicate must not only COVER every member, it must
EXCLUDE every same-stratum file that did NOT cluster. A predicate that reaches a non-member is
unfaithful reach evidence, so the family is dropped.

## Clean family (must be FOUND)

`src/clean/*Service.ts` — five structurally-identical service classes, owner `clean/services`,
`aspects: []`. Their directory holds no same-affix non-member, so the fitted glob
`src/clean/*Service.ts` faithfully covers exactly the five and reaches nothing else. Expected:
one family, `language: typescript`, glob `src/clean/*Service.ts`. This family being found proves
clustering + fitting still work — so the dropped family below is a genuine drop, not a failure
to cluster.

## Over-match family (must be DROPPED)

`src/repo/` holds five structurally-identical `*Repository.ts` classes (they cluster) PLUS
`src/repo/LegacyRepository.ts`, which is structurally distinct (it has a branch the others lack,
so it does NOT cluster) yet shares the `*Repository.ts` filename affix and the `export class …`
declaration. The tightest glob that covers the five members (`src/repo/*Repository.ts`) also
matches `LegacyRepository.ts`, and the shared structural regex matches its class declaration too
— so no faithful predicate exists. The miner MUST drop this family. Expected: none of the
`src/repo/` files appear in any reported family, and no reported family's predicate matches
`src/repo/LegacyRepository.ts`.

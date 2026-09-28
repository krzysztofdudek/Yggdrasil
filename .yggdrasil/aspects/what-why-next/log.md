## [2026-09-24T07:24:36.714Z]
Changed by the owner's mandate that the repository's own rules enforce the CLI's one output grammar. The rule used to accept any rendering that carried the three parts, labelled or not, and exempted report output; it now states the grammar — error[code]: with a labelled why and a next: step for a command error, a block with lowercase at:, why: and fix: fields for a finding, next: and then: last — and the Next contract: a runnable command or an imperative naming a concrete location, a placeholder only for what a person must supply, never a restated code and never the fix repeated word for word. Old-grammar labels and hand-laid findings are violations, and human sign-off is always asked of the user, never addressed as your approval. The corpus gained a legacy-labels case and a restated-code case; its passing cases now use the output layer instead of an Error: prefix.
## [2026-09-27T19:43:06.144Z]
Ratified for types formatter, template: rule version 8fe4689e114cb7d0, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.
## [2026-09-28T04:42:23.939Z]
Ratified for types formatter, template: rule version 86817135d1f6f7cf, admitted by Krzysztof.

Krzysztof admitted this version, asked whether he consents to the new text, with the words: "Popraw wszystko odpowiednio." (2026-09-28). The text now names the directory command modules actually live in (source/cli/src/cli/, not cli/commands/ and cli/cli/), the output-layer helper by its real name (thenStep, not then), and the missing-graph message as the loader actually renders it. The requirement itself is unchanged.

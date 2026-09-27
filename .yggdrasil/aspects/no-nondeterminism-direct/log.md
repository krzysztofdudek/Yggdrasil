## [2026-09-23T20:10:34.432Z]
The rule-script half of this rule matched only rule scripts one directory below the aspects root, although its own comment said nested ones were included, so the grouped aspect ids' rule scripts were never checked for clock, randomness or environment reads. The glob now reaches every depth, and a drill case with a nested rule script that reads the clock proves it.
## [2026-09-27T19:43:06.144Z]
Ratified for types ast-adapter, engine, relations-adapter, reviewer-dispatch, rule-script, structure-adapter: rule version aa12cb7441c61ad2, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.

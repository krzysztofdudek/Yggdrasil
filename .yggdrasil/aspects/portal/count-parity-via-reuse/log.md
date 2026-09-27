## [2026-09-23T20:10:33.243Z]
The positive arm, which the rule calls its real guarantee, was keyed on one node id, so renaming the portal's engine facade would have dropped the requirement without a word, and the description claimed every pipeline node carried a requirement it never had. The manifest is now keyed on the architecture type: every engine-facade node must call the check and pair-computation entry points, pipeline nodes carry no positive requirement because they reach the engine through the facade, and a node of a type the manifest does not know is refused rather than skipped.
## [2026-09-27T19:43:06.144Z]
Ratified for types portal-engine-api, portal-pipeline: rule version e67ab99c8f2717eb, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.

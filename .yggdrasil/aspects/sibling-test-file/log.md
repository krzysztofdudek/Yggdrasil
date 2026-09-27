## [2026-09-23T20:10:31.283Z]
The rule judged only the first file of a command node while declaring exact error direction, so the second command in a two-file node (drill beside drill-add, aspects beside aspects-log) could lose its unit test unnoticed. Every file of the node is now judged, which the command type makes safe because each of its files registers a command.
## [2026-09-27T19:43:06.144Z]
Ratified for type command: rule version 0c566dc965c8b0b0, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.

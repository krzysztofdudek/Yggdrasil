## [2026-09-27T19:43:06.144Z]
Ratified for type command: rule version b1fedfb68baceaa2, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.
## [2026-09-28T04:42:22.636Z]
Ratified for type command: rule version 2022b674f608eb02, admitted by Krzysztof.

Krzysztof admitted this version, asked whether he consents to the new text, with the words: "Popraw wszystko odpowiednio." (2026-09-28). The earlier text prescribed raw stream writes, chalk colours and an Error: prefix that two enforced script rules refuse, and named a preamble module that does not exist. The rule now leaves output routing and error form to the rules that already hold every command file and covers what none of them checks: a try/catch around each action ending in abortOnUnexpectedError or failAndExit, loadGraphOrAbort first (with the init and adopt bootstrap exemption), --node trimming, --file resolution through resolveFileArg, and exit codes 1 and 0.

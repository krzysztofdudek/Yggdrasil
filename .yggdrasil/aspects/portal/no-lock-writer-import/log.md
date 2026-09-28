## [2026-09-27T19:43:06.144Z]
Ratified for types portal-engine-api, portal-pipeline, portal-server: rule version ea53e592133a3797, admitted by the graph as it stood when it took up type-law ratification (yg init --upgrade).

This rule already stood enforced on these types before this graph asked for type law to be admitted. The upgrade records it as the law the graph had, so it keeps blocking; nobody re-decided it now. A later change to the rule needs a ratification of its own.
## [2026-09-28T04:42:21.947Z]
Ratified for types portal-engine-api, portal-pipeline, portal-server: rule version ed982165cfed2cb4, admitted by Krzysztof.

Krzysztof admitted this version, asked whether he consents to it, with the words: "Popraw wszystko odpowiednio." (2026-09-28). The rule no longer lists writer names, three of which existed nowhere while the writers added in 6.1.0 (writeLockSync, writeTypeLock, the verdict writer) went unrefused. It now lets portal backend files take from the lock store only its named readers, so any writer added later is refused on arrival, and it bans the persisting fill modules (core/fill and core/fill-writer) wholesale.

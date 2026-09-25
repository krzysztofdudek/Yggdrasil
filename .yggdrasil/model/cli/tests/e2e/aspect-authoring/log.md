## [2026-05-31T08:36:52.684Z]
Adds end-to-end coverage for how a rule is authored and how a locally-run programmable check must behave. A rule supplies its logic either as prose for the language-model reviewer or as a script for the local checker, never both and never neither; a script that misbehaves — returning the wrong shape, throwing, running asynchronously, or pointing at a file it was not handed — must be caught by the runner rather than corrupting the verdict. This suite spawns the real binary to prove the authoring guards and the script-runtime contract, so a malformed rule cannot quietly produce a meaningless result.
## [2026-05-31T09:10:49.554Z]
Updated the suite to assert the corrected behavior after fixing product defects surfaced by this comprehensive E2E effort. The suite previously pinned the actual (defective) behavior so it would stay green either way; now that the defects are fixed, the assertions assert the intended contract instead, so the suite guards the corrected behavior going forward.
## [2026-09-25T21:14:25.223Z]
Assertions follow the one shared aspect-not-found refusal for an unknown rule id, which replaced this command's own wording.

## [2026-07-28T15:06:18.188Z]
New file: the allow-list lookup moved out of the relations pass module into a standalone engine function so both the relation-conformance pass and the new live type-relation gate can share one implementation without adding an unnecessary same-layer coupling for logic that has no dependency on the relations pass itself.

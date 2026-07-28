## [2026-07-28T15:06:29.815Z]
Now also calls the relocated allow-list lookup directly from its new engine home.
## [2026-07-28T15:37:14.315Z]
Added the live type-to-type relation gate as a new phase of the same live pass: statically-resolved import edges between two classified endpoints (an explicit node or a type-covered file) are now checked against the architecture's relation allow-list, the same authority the existing relation-target-forbidden validator and undeclared-dependency check already read.

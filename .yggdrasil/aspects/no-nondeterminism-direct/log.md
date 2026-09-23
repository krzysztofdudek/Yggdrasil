## [2026-09-23T20:10:34.432Z]
The rule-script half of this rule matched only rule scripts one directory below the aspects root, although its own comment said nested ones were included, so the grouped aspect ids' rule scripts were never checked for clock, randomness or environment reads. The glob now reaches every depth, and a drill case with a nested rule script that reads the clock proves it.

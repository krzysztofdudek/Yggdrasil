# variants/excluded-but-mapped

Adds `vendor/` to `coverage.excluded` while an explicit component still maps a
file inside it. Pins that a coverage exclusion cuts everything it matches,
including an explicit mapping entry that names the file directly — the file
is dropped from review the same way a swept-in file would be.

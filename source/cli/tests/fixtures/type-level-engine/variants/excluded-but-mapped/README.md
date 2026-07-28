# variants/excluded-but-mapped

Adds `vendor/` to `coverage.excluded` while an explicit component still maps a
file inside it. Pins that an explicit mapping outranks a coverage exclusion —
the file stays reviewed even though its directory is excluded.

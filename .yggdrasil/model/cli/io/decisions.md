# IO Decisions

**Separation of I/O from domain:** Parsers and stores live in io/ so that cli/core (loader, drift-detector) and cli/commands can remain focused on domain logic. All filesystem access, YAML parsing, and operational state persistence are centralized here.

**Graceful degradation for operational files:** readDriftState and readJournal return empty structures on missing files — these are optional operational metadata. Parsers for config and graph structure throw on invalid input, since those are required for correct operation.

# Model Decisions

**Single source of truth:** All domain types live in model/types.ts. cli/io, cli/core, cli/formatters, cli/commands import from here. No duplicate type definitions — changes propagate via TypeScript.

**Types only, no runtime:** The model exports interfaces and types. No functions, no validation logic. This keeps the layer pure and ensures domain shape is defined independently of parsing or business rules.

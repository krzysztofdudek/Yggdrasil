# I/O Unit Tests — Responsibility

Guards the complete I/O boundary: YAML parsing (architecture, aspect, flow, node, schema, config), artifact file reading, drift-state persistence, audit-log append-only integrity, and secrets loading. Parser bugs silently corrupt the in-memory graph. Drift state loss breaks approval recovery. Audit log loss breaks auditability. Secrets loading failures hide configuration errors that surface as mysterious reviewer behavior.

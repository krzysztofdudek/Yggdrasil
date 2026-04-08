# Core Operations Unit Tests — Responsibility

Prevents silent graph corruption by testing the operations that enforce the system's trust model. A wrong drift classification blocks legitimate work. A wrong approval lets inconsistent state through. A wrong validation result hides errors or creates false alarms. These are the highest-consequence operations in the CLI, and their edge cases — conflicting drift states, boundary hash conditions, approval axis combinations — require dedicated unit coverage.

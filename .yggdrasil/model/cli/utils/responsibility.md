# Utils — Responsibility

Shared utility functions — path normalization, SHA-256 hashing, token estimation, text tokenization, and git timestamp retrieval. Exists to provide stateless, domain-free primitives that multiple CLI modules depend on without coupling them to each other.

Carries no domain logic or architectural knowledge. If a helper starts encoding business rules, it belongs in a domain module instead.

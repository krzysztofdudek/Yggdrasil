# Build Context Command Responsibility

`yg context` is the primary command — agents run this before reading or modifying any mapped source file. (`yg build-context` is a legacy alias.) Exists because agents need a single entry point that takes "I want to work on X" and returns all the constraints, dependencies, and rules that apply.

Blocks output in three cases: (1) file is unmapped — no node owns it, so there is no context to assemble; suggests candidate nodes from the same directory when available; (2) file is inside a blackbox node — prevents agents from receiving minimal blackbox context and guides them to decompose; (3) validation errors affect the node's context scope — agents never receive context built from a structurally broken graph.

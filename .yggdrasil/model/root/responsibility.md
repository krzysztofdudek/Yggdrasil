# Root Responsibility

Root-level project files: repository configuration, documentation, CI/CD workflows, editor tooling, and devcontainer setup.

**In scope:**

- **Docs:** README.md, CHANGELOG.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, SUPPORT.md, AGENTS.md, CLAUDE.md
- **CI/CD:** `.github/` workflows and configuration
- **Editor/tooling:** `.editorconfig`, `.nvmrc`, `.markdownlint-cli2.jsonc`, `.cursor/`, `.claude/`, Yggdrasil.code-workspace
- **Git configuration:** `.gitignore`, `.gitattributes`
- **Container:** `.devcontainer/`
- **License:** LICENSE

**Out of scope:**

- CLI source code (`source/cli/`) — see `cli`
- Documentation site (`docs/`) — see `docs`
- Scripts (`scripts/`) — see `scripts`
- Graph metadata (`.yggdrasil/`) — managed by Yggdrasil itself

# Templates Logic

## installRulesForPlatform

- Switch on platform: cursor → installForCursor; claude-code → installForClaudeCode; etc.; default → installForGeneric
- Each installForX: ensure target dir exists; write rules file (AGENT_RULES_CONTENT) with platform-specific wrapper (frontmatter, section markers, etc.)

## ensureAgentRules

- mkdir .yggdrasil; writeFile agent-rules.md with AGENT_RULES_CONTENT

## Platform-specific paths

- cursor: .cursor/rules/yggdrasil.mdc

- claude-code, aider, gemini, amp: ensureAgentRules; then platform-specific file (CLAUDE.md, etc.) imports or embeds agent-rules

- generic: .yggdrasil/agent-rules.md

## Init copy

- graph-schemas/*.yaml → .yggdrasil/schemas/ (during init, not in this node's logic)

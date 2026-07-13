export const summary = 'Reviewer config — tiers, quality thresholds, parallelism, auto-approval, schema version.';

export const content = `# yg-config.yaml — Schema for the Yggdrasil project configuration
# Located at .yggdrasil/yg-config.yaml — one per project.
# Edit this after running yg init to describe your project.

version: "5.1.0"                  # managed by CLI — do not edit manually. Tracks the CLI version
                                  # that last initialized or upgraded this config.

quality:                          # optional — quality thresholds
  max_direct_relations: 10        #   maximum outgoing relations per node (warning if above)

parallel: 1                       # optional — concurrency limit for the LLM (reviewer) fill phase only
                                  # (positive integer, default: 1). Applies to yg check --approve or to bare
                                  # yg check when auto_approve is enabled. Deterministic checks ignore it —
                                  # they run across an auto-sized worker-thread pool (CPU cores).

debug: false                      # optional — when true, appends all command output to .yggdrasil/.debug.log
                                  # Default: false (off). Log is append-only; rotate or delete manually.

auto_approve: false               # optional — controls the behavior of bare \`yg check\` (with no explicit
                                  #   --approve / --no-approve / --only-deterministic flag).
                                  #
                                  #   false (default): read-only. No writes, no LLM calls, no API keys
                                  #     needed. Equivalent to running \`yg check\` with no flags.
                                  #   "deterministic": bare \`yg check\` behaves as
                                  #     \`yg check --approve --only-deterministic\` — fills only
                                  #     deterministic pairs (free, keyless, local).
                                  #   "full": bare \`yg check\` behaves as \`yg check --approve\` —
                                  #     fills all unverified pairs and may call the reviewer (needs keys).
                                  #
                                  #   Explicit CLI flags (--approve, --no-approve, --only-deterministic)
                                  #   ALWAYS override this setting regardless of the configured value.
                                  #   CI / pre-commit: use the explicit flag form
                                  #   (\`yg check --approve --only-deterministic\`) to stay deterministic
                                  #   and key-free regardless of this setting.

coverage:                         # optional — scopes the unmapped-files gate. Absent = whole repo required (today's behavior).
  required: ["/"]                 #   roots where an uncovered tracked file is an ERROR (blocks). "/" = whole repo.
  excluded: []                    #   roots where an uncovered file is SILENT (no warning).
                                  # Files outside required and excluded are a non-blocking WARNING.
                                  # Subtrees containing their own nested .yggdrasil/ are auto-skipped by every check.

signals:                          # optional — attention-layer switches. Absent = every signal at its default.
  attention: true                 #   attention (default true): the advisory "structurally unusual" note in
                                  #   yg context --file. false silences it. Must be boolean; unknown keys rejected.

reviewer:                         # required only once a judgment (LLM) rule is actually effective —
                                  # used during yg check --approve or when auto_approve triggers a fill.
                                  # A script-only / keyless project (deterministic aspects only, or none)
                                  # needs no reviewer: section at all.
  default: standard               # required when more than one tier is configured; optional with exactly one tier.
                                  #   Must reference one of the keys under reviewer.tiers.
  tiers:                          # required — named tier configurations, minimum one entry.
    standard:                     #   tier name — referenced from aspects via reviewer.tier:
      provider: ollama            #     provider id (one of: ollama, openai, anthropic, google,
                                  #                       openai-compatible, claude-code, codex, gemini-cli)
      consensus: 1                #     positive odd integer >= 1 (3+ for majority vote). Per-tier.
      config:                     #     provider-specific settings — same fields the provider accepts.
        model: "qwen3.5:9b"       #       model id
        endpoint: "http://localhost:11434"   # custom endpoint (required for openai-compatible; ollama defaults to http://localhost:11434)
        temperature: 0            #       reduces variability — keep at 0
        # timeout: 300            #       Per-call timeout in SECONDS (default 300). Only CLI providers.
      # max_prompt_chars: 200000  # optional — assembled reviewer-prompt character cap (positive integer).
                                  #   Checked deterministically before the LLM call. Absent defaults to 50000.
                                  #   Exceeding this limit renders a blocking error naming remedies
                                  #   (split the node, shorten references, or raise the cap).
                                  #   Never participates in verdict identity — tuning it does not
                                  #   invalidate recorded baselines.
    # Add more tiers as needed (e.g. a \`deep\` tier with a higher-capability model for critical aspects).
    # An aspect references a non-default tier via:
    #
    #   reviewer:
    #     type: llm
    #     tier: deep
    #
    # Tier names match ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ and \`default\` is reserved.
    # yg-secrets.yaml is a deep-merge overlay over this file (gitignored): it
    # mirrors the same shape and overrides any field locally — most often a
    # tier's api_key, or pointing a named tier at a different provider/model.
    # Only the tier NAME is folded into a verdict hash, so a local override never
    # invalidates recorded baselines. Keep credentials out of this committed file.
`;

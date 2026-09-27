export const content = `# yg-secrets.yaml — Schema for the local configuration overlay
# Located at .yggdrasil/yg-secrets.yaml — gitignored, one per machine, optional.
#
# A deep-merge overlay over yg-config.yaml: it takes the same keys (yg schemas
# read config) and overrides any of them on this machine only. Mappings merge
# key by key; a scalar or a list replaces the committed value. Its most common
# use is a tier's api_key, or pointing a named tier at another model.
#
# Only the tier NAME is folded into a verdict hash, so an override here never
# invalidates recorded verdicts. Three settings are read from the committed file
# only, and this file cannot change them: coverage.type_level, progressive and
# rules_artifacts. A key yg-config.yaml does not accept is refused here too,
# named against this file — and only on this machine, since CI never reads it.

reviewer:
  tiers:
    standard:                   # a tier yg-config.yaml declares
      config:
        api_key: "sk-..."       # outranks the provider's environment variable
        model: "claude-sonnet-4-5"
`;

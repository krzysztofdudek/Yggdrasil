export const content = `# yg-packages.yaml — Schema for the package record (yg-packages/1)
# Located at .yggdrasil/yg-packages.yaml — committed, written only by yg pack.
#
# What is installed, from where, and what every copied file hashed to at
# install. The package-file-modified rail compares each copied file against
# its recorded hash. Do not edit it by hand; on a merge conflict take one side
# and re-run yg pack add or yg pack update.
#
# A versioned document: a key this build does not know is ignored, not
# refused, while every key below is checked.

schema: yg-packages/1
packages:
  house-style:                                # the package name
    source: https://github.com/acme/yg-rules  # where it was installed from
    package: acme/yg-rules/house-style        # its directory under aspects/packages/
    version: 1.2.0
    requested: latest                         # optional — latest, or the version asked for
    tag: pack/house-style@1.2.0               # optional — the tag the copy came from
    commit: 0123456789abcdef0123456789abcdef01234567   # optional — the commit that tag named
    installed_at: "2026-09-01T12:00:00.000Z"
    files:                                    # every copied file and its sha256 at install
      .yggdrasil/aspects/packages/acme/yg-rules/house-style/naming/content.md: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
`;

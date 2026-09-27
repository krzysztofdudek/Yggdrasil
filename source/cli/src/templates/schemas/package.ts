export const content = `# yg-package.yaml — Schema for a package manifest (yg-package/1)
# Located in a package's directory inside a marketplace repository, beside
# the rule directories it ships.
#
# A versioned document: a key this build does not know is ignored, not
# refused (a field added within yg-package/1 is read by the builds that know
# it), while every key below is checked. yg marketplace check runs the same
# checks an install does.

schema: yg-package/1            # required — the document version
name: house-style               # required — one path segment; the directory it installs under
version: 1.2.0                  # required — semver
requires:
  yg: "6.x"                     # required — the Yggdrasil versions it runs on; checked at install
aspects:                        # required — every rule directory beside this file, and only those
  - naming
  - layering
config:                         # optional — settings a rule reads through ctx.config
  naming:                       #   a rule this package ships
    threshold:                  #   a setting's name
      type: number              #     string | number | boolean
      default: 40               #     of the declared type; what the rule reads until adapted
`;

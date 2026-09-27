export const content = `# yg-marketplace.yaml — Schema for a marketplace manifest (yg-marketplace/1)
# Located at the root of a marketplace repository (a git repository, or a
# directory on this machine) that publishes packages.
#
# A versioned document: a key this build does not know is ignored, not
# refused, while every key below is checked.

schema: yg-marketplace/1        # required — the document version
packages:                       # required — what the marketplace publishes (an empty list is legal)
  - name: house-style           #   required — one path segment, unique in this file
    path: packages/house-style  #   required — the package directory, inside the repository
    version: 1.2.0              #   required — semver; what yg pack add installs by default
`;

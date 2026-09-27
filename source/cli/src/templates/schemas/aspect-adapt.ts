export const content = `# yg-aspect.adapt.yaml — Schema for adapting an installed package rule
# Located beside an installed rule:
#   .yggdrasil/aspects/packages/<owner>/<repo>/<package>/<rule>/yg-aspect.adapt.yaml
#
# An installed rule is never edited — yg check refuses any change to a copied
# file. Everything this repository wants different about the rule goes here.
# yg pack add writes the file with every adaptable key commented out; a key left
# commented out follows the package's default, across updates too.
#
# It is merged over the rule's own yg-aspect.yaml before the rule is validated:
# scalars and lists replace, mappings (reviewer, scope, config) merge key by key.
# name, description, implies, errs and when are what the rule IS, and are refused
# with the reason; any other unknown key is refused as a typo.

status: advisory                # draft | advisory | enforced
review_by: 2027-01-31           # when to re-examine whether the rule earns its place
scope:
  per: file                     # node | file
reviewer:
  tier: deep                    # reviewer rules only; type stays the package's
config:
  threshold: 60                 # a setting the package declares for this rule, of its declared type
`;

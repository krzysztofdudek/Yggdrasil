export const DEFAULT_CONFIG = `version: "4.0.0"

quality:
  max_direct_relations: 10

parallel: 1
`;

export const DEFAULT_ARCHITECTURE = `node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
    relations:
      calls: [service, library]
      uses: [library]
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors — invisible in call graphs but affect blast radius"
  data:
    description: "Database layer, persistence, and data access"
`;

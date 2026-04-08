# Context Types Responsibility

Types for the two context output patterns: ContextPackage (layer-based, internal representation) and ContextMapOutput (structured reference-based output with glossary and budget tracking). Separated from graph types because context assembly evolves independently — adding new output fields or restructuring the map format doesn't touch the core graph model.

ContextPackage uses layers (global, hierarchy, own, relational, aspects, flows) as its organizing principle. ContextMapOutput reorganizes the same data into a consumer-friendly structure with an artifact registry, glossary of aspects/flows, and budget breakdown. The two coexist because ContextPackage is the assembly format and ContextMapOutput is the presentation format.

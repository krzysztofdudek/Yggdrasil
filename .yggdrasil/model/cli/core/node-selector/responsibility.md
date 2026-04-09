# Node Selector Responsibility

Selects graph nodes, aspects, and flows relevant to a natural-language task description. Provides two selection modes: simple node selection (with flow fallback when no nodes match) and three-dimensional enriched selection that scores nodes, aspects, and flows independently and merges the results. Uses keyword matching against graph artifacts — deterministic and fast. Does not use semantic search, embeddings, or fuzzy matching: the graph's artifact text is designed to contain the terms agents would use in task descriptions, making keyword matching sufficient.

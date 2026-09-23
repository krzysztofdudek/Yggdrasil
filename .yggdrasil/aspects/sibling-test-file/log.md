## [2026-09-23T20:10:31.283Z]
The rule judged only the first file of a command node while declaring exact error direction, so the second command in a two-file node (drill beside drill-add, aspects beside aspects-log) could lose its unit test unnoticed. Every file of the node is now judged, which the command type makes safe because each of its files registers a command.

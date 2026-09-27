## [2026-09-24T07:23:20.820Z]
Added so the CLI describes itself in one place: the root help groups the commands by what a reader is doing with one line each, a command's own help opens with that line, lists its options in one style and shows examples, and every error the argument parser raises is reported in the same error grammar as any other command error, with the command's help as the next step and the machine form of the error for a JSON invocation. A flat, wrapped list of every command's long description made the help the hardest page to read and left parser errors as the one error in a different shape.
## [2026-09-24T14:30:13.650Z]
Parser errors read on one line: the parser's "Did you mean" suggestion joins the sentence instead of riding on a line of its own inside the error document's what, and --json on a command that has no JSON form says so instead of suggesting the nearest flag (log add suggested --reason). Colour flags — --color, --color=<when>, --no-color — are taken off the command line before parsing, since the colour library already read them, so every command accepts them instead of refusing them as unknown options.
## [2026-09-26T21:33:23.925Z]
Exported values that no other file reads were found across the source, left over from refactors, and a new repository gate now refuses an export nothing else reads. This component's such names lose their export keyword and stay module-private; where a declaration was not read even inside its own file it is gone. Nothing it does changes: no caller existed to notice.
## [2026-09-27T21:01:54.985Z]
The merge driver is a command git runs rather than one a person types, but it is part of the surface and appears in the grouped help under setup with the exact shape git invokes it with, so a reader who meets it in a git configuration can find what it is.
## [2026-09-27T21:08:34.588Z]
The top-level and check help examples called a bare yg check a read-only gate, which is false on a project that sets auto_approve; the example now says it is read-only unless auto_approve is set.
## [2026-09-27T22:19:05.655Z]
Two help examples failed when run (yg incident list, a path given to yg simulate), and type-suggest was summarised as designing a type when it only reports which existing type a file fits.
## [2026-09-27T22:24:59.103Z]
The grouped help lists the merge-driver command under setup with the exact shape git invokes it with, so a reader who meets it in a git configuration can find what it is. It arrived in one batch with the verdict-vocabulary and coverage work, and the help text written earlier about a bare check being read-only unless auto_approve is set is kept unchanged.
## [2026-09-27T22:26:31.547Z]
A help flag after a mistyped command printed the root help and exited 0, so an agent's typo read as a finished request. The help flag is now dropped when the command it follows does not exist, and the parser reports the unknown command exactly as it does without the flag: a usage error naming the nearest command, exit 1.
## [2026-09-27T23:05:47.947Z]
Taken into the release line with the other surface-drift fixes for the graph model, relations, rules and agent surfaces: help examples that failed when run are corrected, type-suggest is described as reporting a fitting type, and a mistyped command followed by --help is a usage error instead of the root help with exit 0.

# Names say what a thing is

An exported name must describe the thing's role in the system, not its
implementation. `OrderRepository` says what it is; `OrderArrayWrapper` says what
it is made of, and stops being true the moment the array becomes a map.

Refuse an exported name that leans on a data structure, a library, or a
transport. Accept a name a reader who knows the domain, and nothing about this
codebase, would recognise.

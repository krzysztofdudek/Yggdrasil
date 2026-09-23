## [2026-09-16T09:27:40.369Z]
Standing review date renewed from 2026-09-16 to 2027-09-16 at the maintainer's instruction. The rule's wording, reviewer kind and enforcement status are unchanged by this renewal — only the day it next asks to be re-examined moved.
## [2026-09-23T20:10:32.375Z]
The rule judged only a numeric literal passed straight to process.exit, while most commands end through the drain-then-exit helper and some pass a conditional. It now judges both callees and resolves a conditional of literals, so the provable cases its description claims are the cases it checks; an argument the syntax cannot pin down is still left alone, as the under-approximating error direction already said.

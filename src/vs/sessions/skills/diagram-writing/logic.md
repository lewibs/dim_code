# Logic — flowchart

**Reach for it when** a single function or method's own branching and looping control flow is the point — the thing worth understanding is *how it decides*, not who it calls.

**Show:**
- The routine's guards, branches and loops, as the code actually nests them.
- Each decision as a condition the reader can match to the source; each terminal as a real outcome (return value, thrown error, early exit).
- One routine per flowchart. If several functions each have interesting control flow, prefer a Structure view of the module and reserve a flowchart for the one function whose branching genuinely carries the file.

**Mermaid essentials:**
- Begin with `flowchart TD` (top-down) or `flowchart LR` (left-right).
- Node shapes: `A[step]` process, `B{decision?}` branch, `C([start/end])` terminal, `D[/input/]` I/O.
- Edges: `A --> B`; label a branch with `B -->|yes| C` and `B -->|no| D`.
- Keep loops explicit — route an edge back to the loop head.

**Avoid:** flowcharting a function that just calls collaborators in sequence (that is Behavior), and restating the whole module's structure (that is Structure).

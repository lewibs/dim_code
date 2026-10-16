# States — stateDiagram

**Reach for it when** a class has a **stateful parameter** — a field or property whose value moves through a fixed set of modes — or the code models a lifecycle / state machine (a session, a connection, a picker, a wizard).

**Show:**
- The distinct modes the value (or the object) can be in, named from the code's own constants / enum / string literals.
- The transitions between them, labelled with what triggers each one (the method call, event or condition that moves it).
- The entry point, and a terminal state when the lifecycle genuinely ends.

**Mermaid essentials:**
- Begin with `stateDiagram-v2`.
- `[*] --> Idle` marks the initial state; `Done --> [*]` marks a terminal one.
- Transitions: `Idle --> Running : start()`; put the trigger after the colon.
- Nest sub-states with `state Parent { ... }` when a mode has its own internal modes.

**Avoid:** modelling control flow of one call as states (that is Logic), and listing modes with no transitions — the transitions and their triggers are the whole point.

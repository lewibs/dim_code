# Behavior — sequenceDiagram

**Reach for it when** a function, method, API or endpoint calls two or more collaborators, or the file models an event / message flow. It answers "what talks to what, and in what order".

**Show:**
- The participants that actually exchange messages — the real objects, services or modules involved, named from the code.
- The calls between them in execution order, including the return values or responses that matter.
- Branches and loops only when they are part of the story: `alt`/`else` for a real decision, `loop` for a genuine repetition.

**Mermaid essentials:**
- Begin with `sequenceDiagram`.
- Declare participants you want ordered or aliased: `participant DB as Database`.
- Calls: `A->>B: request()` (solid, a call), `B-->>A: result` (dashed, a return). Use `A-)B: event` for async/fire-and-forget.
- Group with `alt Condition ... else ... end`, `opt Condition ... end`, `loop Each item ... end`.

**Avoid:** inventing participants the code doesn't have, and turning a single routine's internal branching into a sequence — that branching is Logic (a flowchart), not Behavior.

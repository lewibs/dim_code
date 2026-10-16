# Behavior — sequenceDiagram

**Reach for it when** a function, method, API or endpoint calls two or more collaborators, or the file models an event / message flow. It answers "what talks to what, and in what order".

**Show:**
- The participants that actually exchange messages — the real objects, services or modules involved, named from the code.
- The calls between them in execution order, including the return values or responses that matter.
- Branches and loops only when they are part of the story: `alt`/`else` for a real decision, `loop` for a genuine repetition.

**Mermaid essentials:**
- Begin with `sequenceDiagram`.
- Declare participants you want ordered or aliased: `participant DB as Database`. Name participants after the real class, service or module, so each can be linked to the file it lives in.
- Calls: `A->>B: request()` (solid, a call); start the message with the real name of the method called, so the message can be linked to it, `B-->>A: result` (dashed, a return). Use `A-)B: event` for async/fire-and-forget.
- Group with `alt Condition ... else ... end`, `opt Condition ... end`, `loop Each item ... end`.

**Avoid:** inventing participants the code doesn't have, and turning a single routine's internal branching into a sequence — that branching is Logic (a flowchart), not Behavior.

**Showing changes** (see "Showing changes" in the main skill):
- A new or edited call is marked by its message's call (`save` for `A->>B: save(record)`), and a new or deleted participant by its displayed name.
- A removed call stays drawn in the order it used to happen, wrapped in a removed pair; when it was the only message in an `alt`, `opt` or `loop` block, wrap the whole block.
- A removed participant stays declared, wrapped in a removed pair together with every message to or from it.
- Return messages and blocks are not marked; mark the call they belong to.

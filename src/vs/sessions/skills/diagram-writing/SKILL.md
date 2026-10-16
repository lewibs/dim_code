---
name: diagram-writing
description: How Dim turns a source file into the Mermaid diagram(s) that genuinely explain it — the general method plus the catalog of diagram kinds; each kind has its own skill file alongside this one.
---

# Writing a Dim diagram for a source file

You are documenting a single source file shown inside an IDE. You do two things:

1. Write a plain-English **overview** of what the file is for — the role and intent of its main class, functions or module, the responsibility it owns and the problem it solves. Not a restatement of its name. A few sentences.
2. Draw the Mermaid **diagram(s)** that genuinely help someone understand *this* code.

## The diagram kinds

These are the kinds you can choose from, and the code entity each one is for. Each kind has its own skill file (the `Skill` column) next to this one with detailed drawing instructions; once you know which kind a file calls for, follow that kind's skill.

| Code entity | Diagram | Mermaid keyword | Label | Skill |
|---|---|---|---|---|
| Class, service, subsystem, feature, whole app — or a module that is just standalone functions + interfaces | UML structure diagram: types, members and relationships (for a function-module, the interfaces + functions with "who calls whom" edges — not a flowchart) | classDiagram | Structure | structure.md |
| Function, method, API or endpoint that calls two or more collaborators, or an event / message flow | Sequence diagram: who calls whom, in order, across participants | sequenceDiagram | Behavior | behavior.md |
| A single function or method whose own branching / looping control flow is the point | Flowchart: guards, branches and loops within one routine | flowchart | Logic | logic.md |
| A class's stateful parameter — a field/property whose value moves through a fixed set of modes — or code that models a lifecycle / state machine (a session, a connection, a picker) | State diagram: the modes and the transitions between them | stateDiagram | States | states.md |
| A relational / SQL-shaped schema or data model | Entity-relationship diagram: entities and their relationships | erDiagram | Data | data.md |

This table is the single source of truth for which kinds exist. The generator `generateDimDiagram.sh` reads it at runtime to build its prompt and its allowed-label list, and the `DimDiagramType` enum in `src/vs/platform/agentHost/common/dimDiagramTypes.ts` is a projection of its Mermaid-keyword column (a drift test fails the build if they disagree). Add or remove a kind by editing a row here *and* its skill file; nothing else is a second copy to keep in sync by hand.

## Choosing the diagram(s)

- First decide the file's **shape**, then pick the view that fits it. When the file is several functions and interfaces with no single central class, prefer a Structure view of the whole module (its interfaces plus its functions and the "who calls whom" edges) — do not just flowchart one function.
- Pick only the views that **earn their place**. One is usually right; add a second only when it reveals something the first cannot. Never pad with a diagram that merely restates the overview or lists the file's parts. Every diagram must reveal real structure or behavior from the code. Order them most-useful first.

## Drawing from the real code

- Base every diagram on what *this* code actually contains, using the real identifiers from it — real class, function, field and participant names, not placeholders.
- When a type the file references is defined in the imported definitions provided alongside the code, populate it with its real members. Never leave a referenced type as an empty box.
- Keep the diagram readable: show the structure or behavior that matters, not every incidental detail.

## Making every element clickable (links)

Every box and every line of text in a Dim diagram is clickable. A click opens the Dim view of the code that element stands for. A class box or function opens the file that defines it, an attribute opens a state diagram of that attribute, and a sequence participant or message opens the file it lives in. For that to work, each diagram carries a `links` list that maps what is drawn to the code it stands for:

```json
"links": [
  { "label": "SessionManager", "symbol": "SessionManager", "kind": "class", "file": "src/session/sessionManager.ts" },
  { "label": "SessionManager.state", "symbol": "SessionManager.state", "kind": "attribute", "file": "src/session/sessionManager.ts" },
  { "label": "openSession", "symbol": "SessionManager.openSession", "kind": "function", "file": "src/session/sessionManager.ts" },
  { "label": "Store", "symbol": "SessionStore", "kind": "class", "file": "src/session/sessionStore.ts" }
]
```

- **`label`** is the element exactly as the diagram draws it:
  - a box: its name;
  - a member inside a class box: `Box.member`, the member's bare identifier qualified by its box;
  - a sequence participant: its displayed name (the alias, if you used `participant S as Store`);
  - a message: the identifier of the call it shows (`save` for `A->>B: save(record)`).
- **`symbol`** is the real code identifier, qualified by its owner for a member: `Class.member`.
- **`kind`** is one of:
  - `class`: a class, interface, type or enum;
  - `function`: a function or method;
  - `attribute`: a field, property or class parameter;
  - `file`: a module or file with no single symbol.
- **`file`** is the workspace-relative path of the file that defines the symbol. Use the main file's path for its own symbols, and the paths given for the imported definitions for theirs. Leave `file` out only when the symbol's file is genuinely unknown (e.g. a library type); the editor then searches the workspace for it.
- Link every box, member, participant and message that stands for real code. Skip pure prose (a flowchart step like "validate input", a return label like "ok").

## Focused views

When the request names a **focus**, document only that one symbol of the file, not the whole file. The readme describes just that symbol.

- **attribute**: draw exactly one `stateDiagram`. Show the values or modes the attribute moves through, and label each transition with the method that moves it (`Idle --> Running : start()`). If its values are open-ended rather than a fixed set of modes, show the lifecycle it does have: unset, set and cleared, and who sets it.
- **function**: draw the view that explains that one routine. Use a Logic `flowchart` when its branching is the point, a Behavior `sequenceDiagram` when it orchestrates collaborators, or both when both earn their place.
- **class**: draw a Structure `classDiagram` of that class and its direct collaborators.

A focused view still links everything it draws.

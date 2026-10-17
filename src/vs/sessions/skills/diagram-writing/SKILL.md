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
| Function, method, API or endpoint that calls two or more collaborators, or an event / message flow | Sequence diagram: who calls whom, in order, across participants | sequenceDiagram | Sequence | sequence.md |
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
- **Draw every element whole.** You choose *which* elements a diagram shows, but each element you draw shows everything about it, never a selection. A reader must be able to trust that what a box doesn't list, the code doesn't have. Each kind's skill says what "whole" means for it:
  - a class, interface or type box lists **every** member: each field and property, constructor parameter properties, every method, getter and setter, static and instance, public, protected and private alike;
  - a module box lists every function it declares;
  - a drawn routine (a flowchart, or a sequence of one function's calls) shows every branch, guard, early return, throw, loop and call it makes;
  - a state diagram shows every value the attribute can take and every transition between them;
  - an entity shows every attribute.
- Keep the diagram readable by drawing **fewer elements**, or by splitting a large element into a view focused on it, never by trimming the elements you draw.
- An imported type is drawn whole too. Draw it only when its full definition is in front of you: if the definition you were given was cut short, read the rest, or leave the type as a plain referenced name in a relationship rather than drawing a partial box.

## Making every element clickable (links)

Every box and every line of text in a Dim diagram is clickable. A click opens the Dim view of the code that element stands for. A class box or function opens the file that defines it, an attribute opens a state diagram of that attribute, and a sequence participant or message opens the file it lives in. For that to work, each diagram carries a `links` list that maps what is drawn to the code it stands for:

```json
"links": [
  { "label": "SessionManager", "symbol": "SessionManager", "kind": "class", "file": "src/session/sessionManager.ts", "detail": "Owns the open sessions and the one in focus." },
  { "label": "SessionManager.state", "symbol": "SessionManager.state", "kind": "attribute", "file": "src/session/sessionManager.ts", "detail": "Whether the manager is idle, opening or closing a session." },
  { "label": "openSession", "symbol": "SessionManager.openSession", "kind": "function", "file": "src/session/sessionManager.ts", "detail": "Restores a session from the store, or starts a new one." },
  { "label": "Store", "symbol": "SessionStore", "kind": "class", "file": "src/session/sessionStore.ts", "detail": "Saves sessions to disk between launches." }
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
- **`view`** (optional) picks the view the link opens on, in place of the one its kind opens on: `readme`, `classDiagram`, `sequenceDiagram`, `flowchart`, `stateDiagram`, `erDiagram`, or `raw` for the file itself in the text editor. Use it when one view of the target answers what the element is about, e.g. `"view": "sequenceDiagram"` for a participant whose behavior matters more than its structure.
- **`detail`** is one short sentence on what the element does or holds, in plain words, shown in a card when the pointer rests on the element. Say what the drawing can't: its purpose or effect, not its name or type again. Give one on every link.
- **`line`** and **`endLine`** (optional, 1-based) point at specific lines of `file`. A link with a line opens the file raw with those lines selected (just `line` when `endLine` is left out). Use them for an element that stands for a few lines rather than a symbol, such as a flowchart step that is one `if` in a long function. Give lines only when you read them from the file's current code.

## Focused views

When the request names a **focus**, document only that one symbol of the file, not the whole file. The readme describes just that symbol.

- **attribute**: draw exactly one `stateDiagram`. Show the values or modes the attribute moves through, and label each transition with the method that moves it (`Idle --> Running : start()`). If its values are open-ended rather than a fixed set of modes, show the lifecycle it does have: unset, set and cleared, and who sets it.
- **function**: draw the view that explains that one routine. Use a Logic `flowchart` when its branching is the point, a Sequence `sequenceDiagram` when it orchestrates collaborators, or both when both earn their place.
- **class**: draw a Structure `classDiagram` of that class and its direct collaborators.

A focused view still links everything it draws.

## Showing changes

When the request includes a **diff** (the file has changes that are not committed yet), the diagrams also show what changed. The viewer colors each element by its change: green for added, yellow for changed, red for removed. After the changes are committed, the viewer resets the diagram: added and changed elements go back to normal, and removed elements disappear. For that reset to work without redrawing, mark changes only in the two ways below, and never with mermaid `style`, `classDef`, `class` or `:::` styling.

1. Each diagram gets a **`changes`** list naming every element the diff touched:

   ```json
   "changes": [
     { "label": "SessionManager.close", "change": "added" },
     { "label": "SessionManager.openSession", "change": "changed" },
     { "label": "SessionStore.flush", "change": "removed" }
   ]
   ```

   - **`label`** names the element exactly as a link's `label` does: a box's name, `Box.member` for a member, a participant's displayed name, or a message's call. An edge label is named by its text. Labels must match what the diagram draws, or the element cannot be colored.
   - **`change`** is `added` (new in the current code), `changed` (it still exists, but its code changed) or `removed` (it is gone from the current code).
   - Mark the element that best owns a change. For a change inside a method body, mark the method (`Box.method`), not the whole class. Mark a box `changed` only when its own declaration changed (its name, its base types, its fields as a whole). A box whose members were all added is itself `added`.
2. Keep each **removed** element drawn, as it was in the last commit (the diff's `-` lines), so the reader sees what went away. Wrap each removed element in a pair of comment lines, each on a line of its own:

   ```
   %% dim:removed
   ...the removed element's lines...
   %% dim:end
   ```

   Everything between the two lines is deleted when the changes are committed, so the pair must enclose whole lines that can be deleted together and still leave valid mermaid. Put the pair inside a box or block when only part of it was removed, and around the whole box or block when all of it was. Also wrap any line that only exists to connect a removed element, such as an edge to a removed box.

Draw the diagram from the current code as usual, then add the removed elements back. Do not mark anything the diff did not touch. Do not output `changes` or removed markers when the request has no diff. When the file is new (not in the last commit), the viewer shows the whole diagram as added, so output no `changes` and no markers either. Each kind's skill says what to mark in that kind of diagram.

For a test file, mark its tests the same way. Give each entry of `tests` that the diff touched a `change` field (`added`, `changed` or `removed`), and leave it out of the rest. Keep each removed test in the list, described as it was before the change, so the README's tests table can show it struck through until the changes are accepted.

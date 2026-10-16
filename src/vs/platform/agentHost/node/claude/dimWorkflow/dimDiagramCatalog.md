# Dim diagram catalog

The single source of truth for which diagram kinds exist and which code entity each one is for. Mirrors the "Code entity → diagram mapping" table in `PLAN.md` (minus the dropped mindmap). This is the file to edit when adding, removing or re-describing a diagram kind.

The generator `generateDimDiagram.sh` reads the table below at runtime to build its prompt. It is a plain shell script and cannot import TypeScript, which is why the catalog lives here as data instead of in the enum.

The `DimDiagramType` enum in `src/vs/platform/agentHost/common/dimDiagramTypes.ts` lists the same Mermaid keywords as TypeScript types — TypeScript needs them for typing the stored records and for localized UI labels, and it cannot read this file (the browser has no filesystem). It is a projection of this table, not a second copy to maintain by hand: the test `src/vs/platform/agentHost/test/node/dimDiagramCatalog.test.ts` fails the build if the enum and this table ever list different keywords, so the two cannot silently drift.

Only the rows of the table are parsed; this prose and the header/divider rows are ignored.

| Code entity | Diagram | Mermaid keyword | Label |
|---|---|---|---|
| Class, service, subsystem, feature, whole app — or a module that is just standalone functions + interfaces | UML structure diagram: types, members and relationships (for a function-module, the interfaces + functions with "who calls whom" edges — not a flowchart) | classDiagram | Structure |
| Function, method, API or endpoint that calls two or more collaborators, or an event / message flow | Sequence diagram: who calls whom, in order, across participants | sequenceDiagram | Behavior |
| A single function or method whose own branching / looping control flow is the point | Flowchart: guards, branches and loops within one routine | flowchart | Logic |
| Code that models a lifecycle or state machine (a session, a connection, a picker), or a field whose value moves through a fixed set of modes | State diagram: the modes and the transitions between them | stateDiagram | States |
| A relational / SQL-shaped schema or data model | Entity-relationship diagram: entities and their relationships | erDiagram | Data |

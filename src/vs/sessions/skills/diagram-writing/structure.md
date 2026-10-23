# Structure — classDiagram

**Reach for it when** the file is a class, service, subsystem, feature or whole app — or a module that is just standalone functions plus interfaces. It is the default view for "what are the parts of this code and how do they relate".

**Show:**
- The main type(s) the file declares, each with **all** of its members: every field and property (including constructor parameter properties), every method, getter and setter, static and instance, at every visibility. Never leave a member out because it seems trivial or private; mark its visibility instead.
- Relationships between types: inheritance/implementation, composition and the types a class holds or depends on.
- For a **function-module** (no central class): draw the interfaces it declares, each with all its members, and every function it declares (exported or not), with edges for "who calls whom". This shape is a Structure view, not a flowchart of one function.

**Mermaid essentials:**
- Begin with `classDiagram`.
- Members: `+methodName(param: Type): ReturnType` and `+fieldName: Type`. Use `+` public, `-` private, `#` protected. Use the members' real identifiers, so each member row can be linked to its code.
- Order each box's members by visibility: public first, then protected, then private, so a box leads with what the type offers. The viewer also sorts them this way.
- Relationships: `A <|-- B` (B extends/implements A), `A *-- B` (composition), `A --> B` (association/uses), `A ..> B` (dependency). Label an edge with `A --> B : uses`.
- Draw each standalone function as its own box with the `<<function>>` stereotype and its full signature as its one member (`+name(param: Type) ReturnType`), and each top-level constant as a box with `<<constant>>`. Never group them under an invented box named for the module.
- A class's injected services are fields of the class whose constructor declares them. When a class passes services on to `super(...)`, they belong on the parent's box, not the child's; draw the parent with an inheritance edge.

**Avoid:** empty or partial boxes. A referenced type you draw as a box lists all its members, read from its definition; one whose definition you can't find stays a name on a relationship. When a file has too many types to draw whole in one readable diagram, split them across several Structure diagrams (for example one per class and its collaborators) that together cover every type; never draw fewer types or fewer members.

**Showing changes** (see "Showing changes" in the main skill):
- A new class or interface is `added` by its name; a deleted one stays drawn, wrapped whole (its `class` block and every relationship line that touches it) in a removed pair.
- A new, edited or deleted method or field is marked as `Box.member`. A member whose body changed but whose signature did not is still `changed`. A deleted member stays in its class block, wrapped in a removed pair inside the block.
- Relationship lines cannot be colored on their own. To show a changed relationship, give it a label and mark that label. Wrap a removed relationship line in a removed pair.

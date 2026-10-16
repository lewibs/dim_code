# Structure — classDiagram

**Reach for it when** the file is a class, service, subsystem, feature or whole app — or a module that is just standalone functions plus interfaces. It is the default view for "what are the parts of this code and how do they relate".

**Show:**
- The main type(s) the file declares, each with the members that matter — public methods and the fields that carry state. Favour the members a reader needs to understand the type's job; drop trivial getters and private plumbing.
- Relationships between types: inheritance/implementation, composition and the types a class holds or depends on.
- For a **function-module** (no central class): draw the interfaces it declares and its exported functions, with edges for "who calls whom". This shape is a Structure view, not a flowchart of one function.

**Mermaid essentials:**
- Begin with `classDiagram`.
- Members: `+methodName(param: Type): ReturnType` and `+fieldName: Type`. Use `+` public, `-` private, `#` protected.
- Relationships: `A <|-- B` (B extends/implements A), `A *-- B` (composition), `A --> B` (association/uses), `A ..> B` (dependency). Label an edge with `A --> B : uses`.
- Group standalone functions under a single class box named for the module when there is no real class.

**Avoid:** empty boxes for referenced types (populate them from the imported definitions), and dumping every field and method — select what explains the type.

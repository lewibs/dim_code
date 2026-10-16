# Data — erDiagram

**Reach for it when** the file describes a relational / SQL-shaped schema or a data model — tables, records or entities that relate to one another by keys.

**Show:**
- The entities (tables / record types) the code defines, named from it.
- Each entity's meaningful attributes, with their types and any key markers.
- The relationships between entities and their cardinality (one-to-one, one-to-many, many-to-many).

**Mermaid essentials:**
- Begin with `erDiagram`.
- Relationship + cardinality: `CUSTOMER ||--o{ ORDER : places` (one customer, zero-or-more orders). Crow's-foot ends: `|o` zero-or-one, `||` exactly-one, `}o` zero-or-many, `}|` one-or-many.
- Attributes go in a block: `CUSTOMER { string name PK\n string email }`. Mark keys with `PK` / `FK`.
- The text after the colon labels the relationship (`places`, `contains`).

**Avoid:** using it for plain object/class structure that isn't a data schema (that is Structure), and drawing entities with no relationships between them.

**Showing changes** (see "Showing changes" in the main skill):
- A new, changed or deleted entity is marked by its name. A new, retyped or deleted attribute is marked as `ENTITY.attribute` and colors its whole entity, since attribute rows cannot be colored on their own; mark the entity `changed` too.
- A removed attribute stays in its entity block, wrapped in a removed pair inside the block. A removed entity is wrapped whole, together with every relationship line that touches it.
- A changed relationship is marked by its label (the text after the `:`), and a removed one is wrapped in a removed pair.

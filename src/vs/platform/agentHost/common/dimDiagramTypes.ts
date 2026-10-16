/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The kinds of mermaid diagram a Dim `.dim` record can hold. The string value of
 * each member is the mermaid keyword that opens such a diagram, so it doubles as
 * the stored `type` tag in a `.dim` record and as the token used to infer a
 * diagram's kind from raw mermaid source (see {@link inferDimDiagramType}).
 */
export const enum DimDiagramType {
	/** UML class diagram — the structural view of code. */
	Class = 'classDiagram',
	/** Sequence diagram — the behavioral view: who calls whom, in order. */
	Sequence = 'sequenceDiagram',
	/** Flowchart — control flow within a routine, or a high-level component graph. */
	Flowchart = 'flowchart',
	/** State diagram — a class's stateful parameter: a field/property whose value moves through a fixed set of modes. */
	StatefulParameter = 'stateDiagram',
	/** Entity-relationship diagram — a relational / SQL-shaped data model. */
	Entity = 'erDiagram',
}

/**
 * Every diagram kind, in the canonical order the `.dim` viewer lists them. A plain
 * array because {@link DimDiagramType} is a `const enum` and so has no runtime
 * `Object.values`. Which kinds exist and when to use each is owned by the kinds table
 * in the diagram-writing skill `sessions/skills/diagram-writing/SKILL.md` that the
 * generator reads; this array mirrors its keywords for TypeScript, and a drift test
 * keeps the two identical, so a kind can never be added to one without the other.
 */
export const dimDiagramTypes: readonly DimDiagramType[] = [
	DimDiagramType.Class,
	DimDiagramType.Sequence,
	DimDiagramType.Flowchart,
	DimDiagramType.StatefulParameter,
	DimDiagramType.Entity,
];

/**
 * The default label for a diagram whose stored `type` is not a known
 * {@link DimDiagramType} (for example a legacy raw-mermaid `.dim` record).
 */
export const dimDiagramFallbackLabel = "Diagram";

/**
 * Infers the {@link DimDiagramType} of a block of mermaid source from its opening
 * keyword, defaulting to {@link DimDiagramType.Flowchart} (the mermaid default)
 * when nothing more specific matches.
 *
 * @param mermaid The mermaid diagram source.
 */
export function inferDimDiagramType(mermaid: string): DimDiagramType {
	const head = mermaid.trimStart().toLowerCase();
	if (head.startsWith('classdiagram')) { return DimDiagramType.Class; }
	if (head.startsWith('sequencediagram')) { return DimDiagramType.Sequence; }
	if (head.startsWith('statediagram')) { return DimDiagramType.StatefulParameter; }
	if (head.startsWith('erdiagram')) { return DimDiagramType.Entity; }
	return DimDiagramType.Flowchart;
}

/**
 * The short, title-cased label stored for a diagram of the given `type`. This is the
 * record's own fallback label (the generator already writes a `label` from the kinds
 * table); keep the strings in step with the labels in the diagram-writing `SKILL.md`. The
 * `.dim` viewer's toggle uses its own localized labels, so these are plain English
 * record data, not UI strings. Unknown/legacy types fall back to
 * {@link dimDiagramFallbackLabel}.
 *
 * @param type The stored diagram type tag.
 */
export function dimDiagramLabel(type: string): string {
	switch (type) {
		case DimDiagramType.Class: return "Structure";
		case DimDiagramType.Sequence: return "Sequence";
		case DimDiagramType.Flowchart: return "Logic";
		case DimDiagramType.StatefulParameter: return "States";
		case DimDiagramType.Entity: return "Data";
		default: return dimDiagramFallbackLabel;
	}
}

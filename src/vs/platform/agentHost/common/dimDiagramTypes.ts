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
	/** State diagram — a state machine's modes and transitions. */
	State = 'stateDiagram',
	/** Entity-relationship diagram — a relational / SQL-shaped data model. */
	Entity = 'erDiagram',
	/** Mindmap — a hierarchical breakdown (feature tree, responsibilities). */
	Mindmap = 'mindmap',
}

/**
 * Describes one diagram kind: how it is labelled in the UI, what code it suits,
 * when to reach for it, and whether it can be generated deterministically.
 */
export interface IDimDiagramInfo {
	/** Short, title-cased label shown on the `.dim` viewer toggle button. */
	readonly label: string;
	/** One-line description of what the diagram communicates. */
	readonly summary: string;
	/** The code entities this diagram is a natural fit for. */
	readonly appliesTo: readonly string[];
	/** The situation in which this is the right diagram to reach for. */
	readonly useWhen: string;
	/**
	 * How the diagram can be produced: `structure` kinds come from the AST
	 * deterministically, `behavior` kinds need LSP call-hierarchy and/or an LLM
	 * because they encode ordering, state or intent the syntax alone does not carry.
	 */
	readonly dimension: 'structure' | 'behavior';
}

/**
 * The canonical mapping of diagram kind to the code structures and situations it
 * should be used for. This is the single source of truth that a diagram
 * generator consults to decide which diagram(s) a given code entity warrants; the
 * `.dim` viewer only renders whatever diagrams a record already holds. Keep this
 * in sync with the "Code entity -> diagram mapping" table in `PLAN.md`.
 */
export const dimDiagramCatalog: { readonly [type in DimDiagramType]: IDimDiagramInfo } = {
	[DimDiagramType.Class]: {
		label: "Structure",
		summary: "Types, members and relationships — what the code is made of.",
		appliesTo: ['class', 'service', 'subsystem', 'feature', 'module'],
		useWhen: "You want the shape of a class, a service and its dependencies, or the main components of a feature.",
		dimension: 'structure',
	},
	[DimDiagramType.Sequence]: {
		label: "Behavior",
		summary: "Who calls whom, in what order, across participants.",
		appliesTo: ['function', 'method', 'api', 'endpoint', 'event', 'feature'],
		useWhen: "A callable fans out to two or more collaborators, or you want to trace a flow across files.",
		dimension: 'behavior',
	},
	[DimDiagramType.Flowchart]: {
		label: "Logic",
		summary: "Control flow — guards, branches and loops within one routine.",
		appliesTo: ['function', 'method', 'event'],
		useWhen: "A routine's own branching logic is the thing worth understanding, or for a high-level component graph.",
		dimension: 'structure',
	},
	[DimDiagramType.State]: {
		label: "States",
		summary: "The modes a component moves through and the transitions between them.",
		appliesTo: ['class', 'service', 'component'],
		useWhen: "Code models a lifecycle or state machine (a picker, a connection, a session).",
		dimension: 'behavior',
	},
	[DimDiagramType.Entity]: {
		label: "Data",
		summary: "Entities and their relationships — a relational data model.",
		appliesTo: ['schema', 'entity', 'model'],
		useWhen: "There is an actual relational / SQL-shaped schema to show.",
		dimension: 'structure',
	},
	[DimDiagramType.Mindmap]: {
		label: "Overview",
		summary: "A hierarchical breakdown of a thing into its parts.",
		appliesTo: ['subsystem', 'feature', 'whole-app'],
		useWhen: "You want a top-level feature tree or a responsibilities overview at a glance.",
		dimension: 'structure',
	},
};

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
	if (head.startsWith('statediagram')) { return DimDiagramType.State; }
	if (head.startsWith('erdiagram')) { return DimDiagramType.Entity; }
	if (head.startsWith('mindmap')) { return DimDiagramType.Mindmap; }
	return DimDiagramType.Flowchart;
}

/**
 * Resolves the UI label for a stored diagram `type`, falling back to the diagram's
 * own `label` where given, then to {@link dimDiagramFallbackLabel}.
 *
 * @param type The stored diagram type tag.
 */
export function dimDiagramLabel(type: string): string {
	const info = (dimDiagramCatalog as Record<string, IDimDiagramInfo>)[type];
	return info ? info.label : dimDiagramFallbackLabel;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A place a diagram click should navigate to. This is only the *shape* of the request:
 * which concrete resource it resolves to — a class box → its source file, a method →
 * its function `.dim`, a stateful attribute → its state-machine `.dim` — is decided on
 * the extension/workbench side, not here. The renderer only reports *what was clicked*.
 */
export interface DimNavigateTarget {
	/** `node` is the whole box (a class, participant, state or entity); `member` is one line inside it. */
	readonly kind: 'node' | 'member';
	/** The box's label — the class / participant / node name. */
	readonly node: string;
	/** The clicked line's text, for `kind: 'member'` (e.g. `+save(): void` or `state: State`). */
	readonly member?: string;
	/** Best-effort classification of a member, from the mermaid group it sits in. */
	readonly memberKind?: 'attribute' | 'method';
	/** The mermaid diagram keyword the click came from (e.g. `classDiagram`), when known. */
	readonly diagramType?: string;
}

export type DimNavigate = (target: DimNavigateTarget) => void;

/** Marks an element already wired, so re-running the enhancer never double-binds. */
const boundAttr = 'dimClickBound';

/**
 * Makes the boxes and the individual text lines of a rendered mermaid diagram
 * clickable, so one diagram can carry *many* independent click targets per box — the
 * box itself, plus each attribute and method inside it — instead of mermaid's single
 * `click`-per-node limit. Every click is routed through `navigate`; `shouldSuppress`
 * lets the caller veto a click that was really the tail of a pan/drag or a zoom gesture.
 *
 * Safe to call after every (re-)render: mermaid replaces the `<svg>` wholesale, and the
 * `boundAttr` guard keeps a second pass over the same SVG from binding twice.
 *
 * @param root The element the diagram's `<svg>` was rendered into.
 * @param navigate Receives the target of each click.
 * @param shouldSuppress Returns `true` to swallow the current click (e.g. mid-pan).
 */
export function enhanceDiagramClickability(root: HTMLElement, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	const svg = root.querySelector('svg');
	if (!svg) {
		return;
	}
	const diagramType = detectDiagramType(svg);
	if (diagramType === 'classDiagram') {
		enhanceClassNodes(svg, diagramType, navigate, shouldSuppress);
	} else if (diagramType === 'sequenceDiagram') {
		enhanceSequence(svg, diagramType, navigate, shouldSuppress);
	} else {
		// flowchart / stateDiagram / erDiagram and anything else: each node is one box.
		enhanceSimpleNodes(svg, diagramType, navigate, shouldSuppress);
	}
}

/** Reads mermaid's own `aria-roledescription` and maps it to a catalog keyword. */
function detectDiagramType(svg: SVGSVGElement): string {
	const role = (svg.getAttribute('aria-roledescription') ?? '').toLowerCase();
	if (role.includes('class')) { return 'classDiagram'; }
	if (role.includes('sequence')) { return 'sequenceDiagram'; }
	if (role.includes('state')) { return 'stateDiagram'; }
	if (role.includes('er')) { return 'erDiagram'; }
	if (role.includes('flowchart') || role.includes('graph')) { return 'flowchart'; }
	return role || 'unknown';
}

/** Collapses whitespace and trims an element's visible text. */
function textOf(el: Element | null | undefined): string {
	return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A class diagram: each `g.node` is a box (→ the class's source file), and every line
 * in its members and methods groups is an independent target (→ that member's `.dim`).
 */
function enhanceClassNodes(svg: SVGSVGElement, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	svg.querySelectorAll('g.node, g.classGroup').forEach(node => {
		const name = classNameFromNode(node);
		if (!name) {
			return;
		}
		// The whole box → the class. Bound without stopping propagation so a click that
		// lands on the box background (not on a member row) reaches this handler.
		bind(node, { kind: 'node', node: name, diagramType }, navigate, shouldSuppress, false);

		// Each attribute / method row → that member. Bound on the row's `g.label` (a wide
		// hit area) and stops propagation so the member wins over the enclosing box.
		bindMembers(node.querySelectorAll('.members-group .nodeLabel, .members .nodeLabel'), 'attribute', name, diagramType, navigate, shouldSuppress);
		bindMembers(node.querySelectorAll('.methods-group .nodeLabel, .methods .nodeLabel'), 'method', name, diagramType, navigate, shouldSuppress);
	});
}

/** Binds one click target per member label in `labels`, on its enclosing row. */
function bindMembers(labels: NodeListOf<Element>, memberKind: 'attribute' | 'method', node: string, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	labels.forEach(label => {
		const member = textOf(label);
		if (!member) {
			return;
		}
		const row = label.closest('g.label') ?? label;
		bind(row, { kind: 'member', node, member, memberKind, diagramType }, navigate, shouldSuppress, true);
	});
}

/** The class name: the title label, else parsed from mermaid's `classId-<Name>-<n>` id. */
function classNameFromNode(node: Element): string {
	const title = textOf(node.querySelector('.label-group .nodeLabel')) || textOf(node.querySelector('.classTitle'));
	if (title) {
		return title;
	}
	const parsed = /^classId-(?<name>.+?)-\d+$/.exec(node.id ?? '');
	return parsed?.groups?.name ?? '';
}

/**
 * A sequence diagram: each actor/participant box is a target, and each message line is
 * an independent target (→ the `.dim` of the call it stands for).
 */
function enhanceSequence(svg: SVGSVGElement, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	svg.querySelectorAll('text.actor, .actor-box, .actor-man').forEach(actor => {
		const name = textOf(actor);
		if (name) {
			bind(actor, { kind: 'node', node: name, diagramType }, navigate, shouldSuppress, false);
		}
	});
	svg.querySelectorAll('text.messageText').forEach(message => {
		const member = textOf(message);
		if (member) {
			bind(message, { kind: 'member', node: '', member, memberKind: 'method', diagramType }, navigate, shouldSuppress, true);
		}
	});
}

/** Flowchart / state / ER and other diagrams: each `g.node` box is a single target. */
function enhanceSimpleNodes(svg: SVGSVGElement, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	svg.querySelectorAll('g.node, .statediagram-state, .er.entityBox').forEach(node => {
		const name = textOf(node.querySelector('.nodeLabel')) || textOf(node);
		if (name) {
			bind(node, { kind: 'node', node: name, diagramType }, navigate, shouldSuppress, false);
		}
	});
}

/**
 * Wires one element as a click target: pointer affordance, a class for hover styling,
 * and a click handler that reports `target` through `navigate`. A click is ignored
 * when `shouldSuppress()` is true (the tail of a pan) or the Alt key is down (a zoom
 * gesture). `stopBubbling` lets an inner target (a member row) win over its box.
 */
function bind(el: Element, target: DimNavigateTarget, navigate: DimNavigate, shouldSuppress: () => boolean, stopBubbling: boolean): void {
	const dataset = (el as HTMLElement).dataset;
	if (dataset?.[boundAttr]) {
		return;
	}
	if (dataset) {
		dataset[boundAttr] = '1';
	}
	el.classList.add('dim-clickable', target.kind === 'member' ? 'dim-clickable-member' : 'dim-clickable-node');
	el.addEventListener('click', event => {
		const mouse = event as MouseEvent;
		if (mouse.altKey || shouldSuppress()) {
			return; // a zoom gesture, or the mouseup that ended a pan — not a navigation click
		}
		if (stopBubbling) {
			event.stopPropagation();
		}
		navigate(target);
	});
}

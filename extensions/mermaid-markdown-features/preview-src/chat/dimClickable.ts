/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A place a diagram click should navigate to. This is only the *shape* of the request:
 * which Dim view it opens — a class box → its file, a method → its file or a view of
 * that function, a stateful attribute → its state diagram — is decided by the extension
 * (`src/dimNavigate.ts`), not here. The renderer only reports *what was clicked*.
 */
export interface DimNavigateTarget {
	/** `node` is the whole box (a class, participant, state or entity); `member` is one line inside it. */
	readonly kind: 'node' | 'member';
	/** The box's label — the class / participant / node name; empty for a message or edge label. */
	readonly node: string;
	/** The clicked line's text, for `kind: 'member'` (e.g. `+save(): void`, `state: State` or a message's `save(record)`). */
	readonly member?: string;
	/** For a sequence message: the participant it is sent to, when known. */
	readonly receiver?: string;
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
	// Edge labels (a state transition's `start()`, a call edge's label) name code too.
	enhanceEdgeLabels(svg, diagramType, navigate, shouldSuppress);
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
 * A sequence diagram: each actor/participant box (its rectangle and its name) is a
 * target (→ the file it lives in), and each message — its text and its arrow — is a
 * target (→ the call it stands for).
 */
function enhanceSequence(svg: SVGSVGElement, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	svg.querySelectorAll('text.actor, .actor-box, .actor-man, rect.actor').forEach(actor => {
		// A participant's rectangle has no text of its own: take its sibling name.
		const name = textOf(actor) || textOf(actor.parentElement?.querySelector('text.actor'));
		if (name) {
			bind(actor, { kind: 'node', node: name, diagramType }, navigate, shouldSuppress, false);
		}
	});
	// Mermaid draws one arrow per message, in the same order as the texts. Pair them up
	// only when the counts agree, so an arrow is never bound to another message's call;
	// the arrow's end then also tells which participant receives the message.
	const messages = svg.querySelectorAll('text.messageText');
	const arrows = svg.querySelectorAll('.messageLine0, .messageLine1');
	const paired = arrows.length === messages.length;
	const lifelines = participantCenters(svg);
	messages.forEach((message, index) => {
		const member = textOf(message);
		if (!member) {
			return;
		}
		const arrow = paired ? arrows[index] : undefined;
		const target: DimNavigateTarget = { kind: 'member', node: '', member, memberKind: 'method', receiver: arrow && receiverOf(arrow, lifelines), diagramType };
		bind(message, target, navigate, shouldSuppress, true);
		if (arrow) {
			bind(widenHitArea(arrow), target, navigate, shouldSuppress, true);
		}
	});
}

/** Each participant's name and the x of its lifeline (the center of its box). */
function participantCenters(svg: SVGSVGElement): { readonly name: string; readonly x: number }[] {
	const centers: { name: string; x: number }[] = [];
	svg.querySelectorAll('rect.actor').forEach(rect => {
		const name = textOf(rect.parentElement?.querySelector('text.actor'));
		const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
		if (name && !Number.isNaN(x) && !centers.some(center => center.name === name)) {
			centers.push({ name, x });
		}
	});
	return centers;
}

/**
 * The participant a message arrow points at: the one whose lifeline is nearest the
 * arrow's end. `undefined` for a self-message (drawn as a path, with no end point) or
 * when there are no participants to choose from.
 */
function receiverOf(arrow: Element, lifelines: readonly { readonly name: string; readonly x: number }[]): string | undefined {
	const end = Number(arrow.getAttribute('x2'));
	if (!arrow.hasAttribute('x2') || Number.isNaN(end) || lifelines.length === 0) {
		return undefined;
	}
	return lifelines.reduce((best, lifeline) => Math.abs(lifeline.x - end) < Math.abs(best.x - end) ? lifeline : best).name;
}

/**
 * Edge labels, in any diagram: a state transition's trigger (`start()`), a call or
 * dependency edge's label. Each is a target for the code it names, if any.
 */
function enhanceEdgeLabels(svg: SVGSVGElement, diagramType: string, navigate: DimNavigate, shouldSuppress: () => boolean): void {
	svg.querySelectorAll('g.edgeLabel').forEach(label => {
		const member = textOf(label);
		if (member) {
			bind(label, { kind: 'member', node: '', member, diagramType }, navigate, shouldSuppress, true);
		}
	});
}

/**
 * A message arrow is a hairline, too thin to hit. Lays a transparent, wide copy of it on
 * top to take the clicks, and returns that copy (the arrow itself is returned when its
 * copy was already made by an earlier pass).
 */
function widenHitArea(arrow: Element): Element {
	const existing = arrow.nextElementSibling;
	if (existing?.classList.contains('dim-hit-area')) {
		return existing;
	}
	const hit = arrow.cloneNode(false) as Element;
	hit.removeAttribute('id');
	hit.removeAttribute('marker-end');
	hit.removeAttribute('marker-start');
	hit.removeAttribute('class');
	hit.classList.add('dim-hit-area');
	hit.setAttribute('style', 'stroke: transparent; stroke-width: 12px; fill: none; pointer-events: stroke;');
	arrow.after(hit);
	return hit;
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { clickedNames, findLink } from '../../src/dimNames';

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
 * How a drawn element is shown: `node` is a box (its shape is filled), `text` a line of
 * text inside or beside one (a member row, a message, an edge label), and `line` a
 * sequence message's arrow.
 */
type DimElementRole = 'node' | 'text' | 'line';

/** Receives each element {@link visitDiagramElements} finds, with what it stands for. */
type DimElementVisitor = (el: Element, target: DimNavigateTarget, role: DimElementRole) => void;

/**
 * How a diagram element changed since the diff base, and so how it is colored. Mirrors
 * `IDimChange` in the extension's `src/dimRecord.ts`; keep the two in sync.
 */
export interface DimChange {
	readonly label: string;
	readonly change: 'added' | 'changed' | 'removed';
}

/**
 * What a diagram element stands for in the code, as the record's `links` say. Mirrors
 * `IDimLink` in the extension's `src/dimRecord.ts`; keep the two in sync.
 */
export interface DimLink {
	readonly label: string;
	readonly symbol: string;
	readonly kind: 'class' | 'function' | 'attribute' | 'file';
	readonly file?: string;
	readonly line?: number;
	readonly endLine?: number;
	readonly detail?: string;
}

/** The localized words of the hover card, from the page's `#dim-hover-labels` data block. */
export interface DimHoverLabels {
	readonly class: string;
	readonly function: string;
	readonly attribute: string;
	readonly file: string;
	readonly added: string;
	readonly changed: string;
	readonly removed: string;
	/** `line {0}`. */
	readonly line: string;
	/** `lines {0}–{1}`. */
	readonly lines: string;
	readonly open: string;
}

/** What the hover card says about one element. */
interface DimHoverInfo {
	readonly title: string;
	readonly link?: DimLink;
	readonly change?: DimChange['change'];
	/** Whether a click on the element can open something. */
	readonly opens: boolean;
}

/** How long the pointer rests on an element before its card shows, in milliseconds. */
const hoverDelay = 350;

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
	// A box lets a click on its background through to it; anything inside or on top of a
	// box (a member row, a message) stops the click so it wins over the box.
	visitDiagramElements(svg, (el, target, role) => bind(role === 'line' ? widenHitArea(el) : el, target, navigate, shouldSuppress, role !== 'node'));
}

/**
 * Colors the elements of a rendered diagram that changed since the diff base: green for
 * added, yellow for changed, red (and struck through) for removed. Each change names an
 * element the way a link does (see "Showing changes" in the `diagram-writing` skill); a
 * member is matched only by its qualified `Box.member` name, so a same-named member of
 * another box is never colored by mistake. Safe to call after every (re-)render.
 *
 * @param root The element the diagram's `<svg>` was rendered into.
 * @param changes The diagram's changes; ignored when `isNew` is set.
 * @param isNew The whole file is new since the diff base, so every element is added.
 */
export function markDiagramChanges(root: HTMLElement, changes: readonly DimChange[], isNew: boolean): void {
	const svg = root.querySelector('svg');
	if (!svg || (!isNew && changes.length === 0)) {
		return;
	}
	const byLabel = new Map(changes.map(change => [change.label, change.change]));
	visitDiagramElements(svg, (el, target, role) => {
		const change = changeOf(target, byLabel, isNew);
		if (change) {
			el.classList.add('dim-change', `dim-change-${change}`, `dim-change-${role}`);
		}
	});
}

/**
 * How an element changed, by the names it goes by. A member is matched only by its
 * qualified `Box.member` name, so a same-named member of another box never matches.
 */
function changeOf(target: DimNavigateTarget, byLabel: ReadonlyMap<string, DimChange['change']>, isNew: boolean): DimChange['change'] | undefined {
	if (isNew) {
		return 'added';
	}
	const names = clickedNames(target);
	const candidates = target.kind === 'member' && target.node ? names.slice(0, 1) : [...names, target.member ?? target.node];
	return candidates.map(name => byLabel.get(name)).find(found => !!found);
}

/**
 * Shows a card describing the element under the pointer once it rests there: the code it
 * stands for (its symbol and kind), the link's one-line `detail`, where it is defined,
 * how the changes waiting for review touched it, and whether a click opens it. An element
 * inside a box (a member row, a message) wins over the box. Elements with nothing to add
 * to their own text (prose with no link or change) get no card. Safe to call after every
 * (re-)render.
 *
 * @param root The element the diagram's `<svg>` was rendered into.
 * @param links The shown diagram's links, looked up first.
 * @param otherLinks The links of the record's other diagrams, looked up next.
 * @param changes The shown diagram's changes; ignored when `isNew` is set.
 * @param isNew The whole file is new since the diff base, so every element is added.
 * @param labels The card's localized words.
 */
export function enhanceDiagramHovers(root: HTMLElement, links: readonly DimLink[], otherLinks: readonly DimLink[], changes: readonly DimChange[], isNew: boolean, labels: DimHoverLabels): void {
	const svg = root.querySelector('svg');
	if (!svg || svg.dataset[boundAttr]) {
		return;
	}
	svg.dataset[boundAttr] = '1';
	const byLabel = new Map(changes.map(change => [change.label, change.change]));
	const infos = new Map<Element, DimHoverInfo>();
	visitDiagramElements(svg, (el, target, role) => {
		const names = clickedNames(target);
		const link = findLink(links, names) ?? findLink(otherLinks, names);
		const change = changeOf(target, byLabel, isNew);
		const text = target.member ?? target.node;
		if (!link && !change) {
			return; // prose: the card would only repeat what is drawn
		}
		const info: DimHoverInfo = { title: link?.symbol || names[0] || text, link, change, opens: !!link || names.length > 0 };
		infos.set(el, info);
		if (role === 'line') {
			infos.set(widenHitArea(el), info);
		}
	});

	const card = hoverCard(root.ownerDocument);
	let shown: Element | undefined;
	let timer: number | undefined;
	const hide = (): void => {
		window.clearTimeout(timer);
		shown = undefined;
		card.hidden = true;
	};
	svg.addEventListener('pointerover', event => {
		const el = innermost(event.target as Element | null, svg, infos);
		if (el === shown) {
			return;
		}
		hide();
		if (!el) {
			return;
		}
		const { clientX, clientY } = event;
		timer = window.setTimeout(() => {
			shown = el;
			fillHoverCard(card, infos.get(el)!, labels);
			placeHoverCard(card, clientX, clientY);
		}, hoverDelay);
	});
	svg.addEventListener('pointerleave', hide);
	// A pan, a zoom or a click moves on from the element: the card would be in the way.
	svg.addEventListener('pointerdown', hide);
	svg.addEventListener('wheel', hide, { passive: true });
}

/** The element under the pointer that has a card, innermost first, or `undefined`. */
function innermost(start: Element | null, svg: SVGSVGElement, infos: ReadonlyMap<Element, DimHoverInfo>): Element | undefined {
	for (let el = start; el && el !== svg; el = el.parentElement) {
		if (infos.has(el)) {
			return el;
		}
	}
	return undefined;
}

/** The page's one hover card, made on first use. */
function hoverCard(doc: Document): HTMLElement {
	const existing = doc.querySelector<HTMLElement>('.dim-hover');
	if (existing) {
		return existing;
	}
	const card = doc.createElement('div');
	card.className = 'dim-hover';
	card.setAttribute('role', 'tooltip');
	card.hidden = true;
	doc.body.appendChild(card);
	return card;
}

/** Writes what the card says about one element. */
function fillHoverCard(card: HTMLElement, info: DimHoverInfo, labels: DimHoverLabels): void {
	const doc = card.ownerDocument;
	const line = (className: string, text: string): HTMLElement => {
		const el = doc.createElement('div');
		el.className = className;
		el.textContent = text;
		return el;
	};
	card.replaceChildren(line('dim-hover-title', info.title));
	const { link, change } = info;
	if (link || change) {
		const meta = doc.createElement('div');
		meta.className = 'dim-hover-meta';
		if (link) {
			meta.appendChild(doc.createElement('span')).textContent = labels[link.kind];
		}
		if (change) {
			const badge = meta.appendChild(doc.createElement('span'));
			badge.className = 'dim-hover-change';
			badge.dataset.change = change;
			badge.textContent = labels[change];
		}
		card.appendChild(meta);
	}
	if (link?.detail) {
		card.appendChild(line('dim-hover-detail', link.detail));
	}
	if (link?.file) {
		const lines = link.line === undefined ? ''
			: link.endLine !== undefined && link.endLine !== link.line ? labels.lines.replace('{0}', String(link.line)).replace('{1}', String(link.endLine))
				: labels.line.replace('{0}', String(link.line));
		card.appendChild(line('dim-hover-location', lines ? `${link.file}, ${lines}` : link.file));
	}
	if (info.opens) {
		card.appendChild(line('dim-hover-hint', labels.open));
	}
}

/** Shows the card below and to the right of the pointer, kept inside the window. */
function placeHoverCard(card: HTMLElement, x: number, y: number): void {
	const offset = 12;
	card.style.left = '0px';
	card.style.top = '0px';
	card.hidden = false;
	const { width, height } = card.getBoundingClientRect();
	const view = card.ownerDocument.defaultView ?? window;
	const left = x + offset + width > view.innerWidth ? Math.max(4, x - offset - width) : x + offset;
	const top = y + offset + height > view.innerHeight ? Math.max(4, y - offset - height) : y + offset;
	card.style.left = `${left}px`;
	card.style.top = `${top}px`;
}

/**
 * Finds the elements of a rendered diagram that stand for code — its boxes, the lines of
 * text inside them, its messages and edge labels — and reports each with what it stands
 * for. Shared by clickability and change coloring, so both treat the same elements.
 */
function visitDiagramElements(svg: SVGSVGElement, visit: DimElementVisitor): void {
	const diagramType = detectDiagramType(svg);
	if (diagramType === 'classDiagram') {
		visitClassNodes(svg, diagramType, visit);
	} else if (diagramType === 'sequenceDiagram') {
		visitSequence(svg, diagramType, visit);
	} else {
		// flowchart / stateDiagram / erDiagram and anything else: each node is one box.
		visitSimpleNodes(svg, diagramType, visit);
	}
	// Edge labels (a state transition's `start()`, a call edge's label) name code too.
	visitEdgeLabels(svg, diagramType, visit);
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
function visitClassNodes(svg: SVGSVGElement, diagramType: string, visit: DimElementVisitor): void {
	svg.querySelectorAll('g.node, g.classGroup').forEach(node => {
		const name = classNameFromNode(node);
		if (!name) {
			return;
		}
		// The whole box → the class.
		visit(node, { kind: 'node', node: name, diagramType }, 'node');

		// Each attribute / method row → that member, on the row's `g.label` (a wide hit area).
		visitMembers(node.querySelectorAll('.members-group .nodeLabel, .members .nodeLabel'), 'attribute', name, diagramType, visit);
		visitMembers(node.querySelectorAll('.methods-group .nodeLabel, .methods .nodeLabel'), 'method', name, diagramType, visit);
	});
}

/** Reports one element per member label in `labels`: its enclosing row. */
function visitMembers(labels: NodeListOf<Element>, memberKind: 'attribute' | 'method', node: string, diagramType: string, visit: DimElementVisitor): void {
	labels.forEach(label => {
		const member = textOf(label);
		if (!member) {
			return;
		}
		visit(label.closest('g.label') ?? label, { kind: 'member', node, member, memberKind, diagramType }, 'text');
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
function visitSequence(svg: SVGSVGElement, diagramType: string, visit: DimElementVisitor): void {
	svg.querySelectorAll('text.actor, .actor-box, .actor-man, rect.actor').forEach(actor => {
		// A participant's rectangle has no text of its own: take its sibling name.
		const name = textOf(actor) || textOf(actor.parentElement?.querySelector('text.actor'));
		if (name) {
			visit(actor, { kind: 'node', node: name, diagramType }, actor.tagName.toLowerCase() === 'text' ? 'text' : 'node');
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
		visit(message, target, 'text');
		if (arrow) {
			visit(arrow, target, 'line');
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
function visitEdgeLabels(svg: SVGSVGElement, diagramType: string, visit: DimElementVisitor): void {
	svg.querySelectorAll('g.edgeLabel').forEach(label => {
		const member = textOf(label);
		if (member) {
			visit(label, { kind: 'member', node: '', member, diagramType }, 'text');
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
function visitSimpleNodes(svg: SVGSVGElement, diagramType: string, visit: DimElementVisitor): void {
	svg.querySelectorAll('g.node, .statediagram-state, .er.entityBox').forEach(node => {
		const name = textOf(node.querySelector('.nodeLabel')) || textOf(node);
		if (name) {
			visit(node, { kind: 'node', node: name, diagramType }, 'node');
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

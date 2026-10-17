/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The names a drawn diagram element goes by, shared by the extension (which resolves a
 * click to a link, `dimNavigate.ts`) and the diagram webview (which colors the elements a
 * record's `changes` name and describes an element on hover, `preview-src/chat/dimClickable.ts`). Free of `vscode` so the
 * webview bundle can import it.
 */

/** A drawn diagram element, as the webview reports it (see `DimNavigateTarget`). */
export interface IDimDrawnElement {
	/** `node` is a whole box; `member` is one line in it, a sequence message or an edge label. */
	readonly kind: 'node' | 'member';
	/** The box's label; empty for a message or edge label, which belongs to no box. */
	readonly node: string;
	/** The line's text, for `kind: 'member'`. */
	readonly member?: string;
	/** For a sequence message: the participant it is sent to, when known. */
	readonly receiver?: string;
}

/** An identifier, as the first capture of a match. */
const identifier = '[A-Za-z_$][\\w$]*';

/**
 * The names a click could refer to, most specific first: `Box.member` and `member` for
 * a member row, `Receiver.call` and `call` for a message or edge label, the name for a
 * box.
 */
export function clickedNames(target: IDimDrawnElement): string[] {
	const node = cleanNodeName(target.node);
	if (target.kind === 'node') {
		const first = new RegExp(`^${identifier}`).exec(node)?.[0];
		return unique([node, first]);
	}
	const member = target.member ?? '';
	if (node) {
		const name = memberIdentifier(member);
		return name ? unique([`${node}.${name}`, name]) : [];
	}
	const call = callIdentifier(member);
	const receiver = target.receiver && cleanNodeName(target.receiver);
	return call ? unique([receiver ? `${receiver}.${call}` : undefined, call]) : [];
}

/** The part of a diagram link that names it: what is drawn, and the code identifier. */
export interface IDimLinkName {
	readonly label: string;
	readonly symbol: string;
}

/** The last dotted segment of a qualified name: `Foo.save` → `save`. */
export function lastSegment(name: string): string {
	return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * Finds the link an element's names (see {@link clickedNames}) refer to: by its drawn
 * label first, then by its symbol, then by the last segment of either (a member drawn
 * without its owner).
 */
export function findLink<T extends IDimLinkName>(links: readonly T[], names: readonly string[]): T | undefined {
	if (links.length === 0 || names.length === 0) {
		return undefined;
	}
	for (const name of names) {
		const byLabel = links.find(link => link.label.trim() === name);
		if (byLabel) {
			return byLabel;
		}
	}
	for (const name of names) {
		const bySymbol = links.find(link => link.symbol === name);
		if (bySymbol) {
			return bySymbol;
		}
	}
	const bare = lastSegment(names[names.length - 1]);
	return links.find(link => lastSegment(link.label.trim()) === bare || lastSegment(link.symbol) === bare);
}

/** Drops empty and repeated names, keeping the first of each. */
export function unique(names: ReadonlyArray<string | undefined>): string[] {
	return [...new Set(names.filter((name): name is string => !!name))];
}

/** A box label without stereotypes (`«interface»`) or generics (`Foo~T~`, `Foo<T>`). */
function cleanNodeName(node: string): string {
	return node.replace(/«[^»]*»|<<[^>]*>>/g, '').replace(/~[^~]*~|<[^>]*>/g, '').trim();
}

/**
 * The identifier of a class member row: `+save(record): void` → `save`,
 * `-state: State` → `state`, `String name` → `name`.
 */
function memberIdentifier(member: string): string | undefined {
	const text = member.replace(/^[+\-#~]\s*/, '').replace(/[$*]/g, '').trim();
	const call = new RegExp(`(?<name>${identifier})\\s*\\(`).exec(text)?.groups?.name;
	if (call) {
		return call;
	}
	const typed = new RegExp(`^(?<name>${identifier})\\s*:`).exec(text)?.groups?.name;
	if (typed) {
		return typed;
	}
	const words = text.match(new RegExp(identifier, 'g'));
	return words?.[words.length - 1];
}

/**
 * The call a message or edge label shows: `save(record)` → `save`, a lone identifier as
 * it is. `undefined` for prose ("spawn the generator"), which names no call.
 */
function callIdentifier(message: string): string | undefined {
	return new RegExp(`(?<name>${identifier})\\s*\\(`).exec(message)?.groups?.name
		?? new RegExp(`^\\s*(?<name>${identifier})\\s*$`).exec(message)?.groups?.name;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { DimLinkKind, IDimLink } from './dimRecord';

/**
 * What a click in a Dim diagram addresses. Mirrors `DimNavigateTarget` on the webview
 * side (`preview-src/chat/dimClickable.ts`): it says what was clicked, and
 * {@link resolveDimNavigation} works out which Dim view that opens.
 */
export interface IDimNavigateTarget {
	/** `node` is a whole box (a class, participant, state or entity); `member` is one line in it, or a sequence message. */
	readonly kind: 'node' | 'member';
	/** The box's label; empty for a sequence message, which belongs to no box. */
	readonly node: string;
	/** The clicked line's text, for `kind: 'member'` (e.g. `+save(): void` or `save(record)`). */
	readonly member?: string;
	readonly memberKind?: 'attribute' | 'method';
	/** For a sequence message: the participant it is sent to, when known. */
	readonly receiver?: string;
	/** The mermaid diagram keyword the click came from (e.g. `classDiagram`). */
	readonly diagramType?: string;
}

/** The kind of symbol a focused Dim view describes. Mirrors `DimFocusKind` in `dimHookStorage.ts`. */
type DimFocusKind = Exclude<DimLinkKind, 'file'>;

/**
 * A symbol, as written in a focus fragment: dotted identifiers. Mirrors the symbol part
 * of `dimFocusPattern` in `dimHookStorage.ts`; keep the two in sync.
 */
const focusSymbolPattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * The source URI of a Dim view focused on one symbol: the file's URI with a
 * `<kind>:<symbol>` fragment, which the workbench maps to that symbol's own record.
 * Mirrors `parseDimFocus` in `dimHookStorage.ts`; keep the two in sync.
 */
function formatDimFocus(file: vscode.Uri, kind: DimFocusKind, symbol: string): vscode.Uri {
	return file.with({ fragment: `${kind}:${symbol}` });
}

/** The symbol a source URI's focus fragment names, if any (see {@link formatDimFocus}). */
export function dimFocusSymbol(uri: vscode.Uri): string | undefined {
	return /^(?:class|function|attribute):(?<symbol>.+)$/.exec(uri.fragment)?.groups?.symbol;
}

/** The code a clicked element was resolved to. */
interface IResolvedSymbol {
	/** The file that defines it. */
	readonly file: vscode.Uri;
	/** Its identifier, qualified by its owner for a member; empty for a whole file. */
	readonly symbol: string;
	readonly kind: DimLinkKind;
}

/** Where a click navigates: the Dim view to open, and the view to show in it. */
export interface IDimDestination {
	/** The source URI to open in the Dim viewer, with a focus fragment for one symbol. */
	readonly uri: vscode.Uri;
	/** The diagram type to show, or `undefined` for the viewer's default (README). */
	readonly viewId?: string;
}

/**
 * Works out which Dim view a click in a diagram opens:
 * - an **attribute** opens a view focused on it, on its state diagram;
 * - a **function** or **class** defined in another file opens that file's view;
 *   one defined in the file being viewed opens a view focused on it;
 * - a **file** (e.g. a module participant) opens that file's view;
 * - a sequence **message** that names no call (prose such as "spawn the generator")
 *   opens what its receiving participant stands for.
 *
 * The clicked element is looked up in the shown diagram's `links` first (written by the
 * generator), then in the record's other diagrams, and finally by name through the
 * language's symbol providers, so a diagram without links still navigates.
 *
 * @param source The URI the clicked Dim view shows (with a focus fragment when focused).
 * @param shownLinks The links of the diagram that was clicked.
 * @param otherLinks The links of the record's other diagrams.
 * @param target What was clicked.
 * @returns Where to go, or `undefined` when the click names no code, or names the view
 * already showing.
 */
export async function resolveDimNavigation(source: vscode.Uri, shownLinks: readonly IDimLink[], otherLinks: readonly IDimLink[], target: IDimNavigateTarget): Promise<IDimDestination | undefined> {
	const sourceFile = source.with({ fragment: '' });
	const resolved = await resolveTarget(sourceFile, shownLinks, otherLinks, target)
		?? (target.receiver ? await resolveTarget(sourceFile, shownLinks, otherLinks, { kind: 'node', node: target.receiver, diagramType: target.diagramType }) : undefined);
	if (!resolved) {
		return undefined;
	}
	const destination = destinationFor(sourceFile, resolved);
	return destination.uri.toString() === source.toString() ? undefined : destination;
}

/** Resolves what a click names: through the diagrams' links, else the symbol providers. */
async function resolveTarget(sourceFile: vscode.Uri, shownLinks: readonly IDimLink[], otherLinks: readonly IDimLink[], target: IDimNavigateTarget): Promise<IResolvedSymbol | undefined> {
	const names = clickedNames(target);
	if (names.length === 0) {
		return undefined;
	}
	const link = findLink(shownLinks, names) ?? findLink(otherLinks, names);
	return link ? resolveLink(sourceFile, link) : resolveBySymbolProviders(sourceFile, names);
}

/** Applies the navigation rules of {@link resolveDimNavigation} to a resolved symbol. */
function destinationFor(sourceFile: vscode.Uri, resolved: IResolvedSymbol): IDimDestination {
	const { file, symbol, kind } = resolved;
	if (kind === 'file' || !focusSymbolPattern.test(symbol)) {
		return { uri: file };
	}
	if (kind === 'attribute') {
		return { uri: formatDimFocus(file, kind, symbol), viewId: 'stateDiagram' };
	}
	const sameFile = file.toString() === sourceFile.toString();
	return sameFile ? { uri: formatDimFocus(file, kind, symbol) } : { uri: file };
}

/** An identifier, as the first capture of a match. */
const identifier = '[A-Za-z_$][\\w$]*';

/**
 * The names a click could refer to, most specific first: `Box.member` and `member` for
 * a member row, `Receiver.call` and `call` for a message or edge label, the name for a
 * box.
 */
function clickedNames(target: IDimNavigateTarget): string[] {
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

/** Drops empty and repeated names, keeping the first of each. */
function unique(names: ReadonlyArray<string | undefined>): string[] {
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

/** The last dotted segment of a qualified name: `Foo.save` → `save`. */
function lastSegment(name: string): string {
	return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * Finds the link a click names: by its drawn label first, then by its symbol, then by
 * the last segment of either (a member drawn without its owner).
 */
function findLink(links: readonly IDimLink[], names: readonly string[]): IDimLink | undefined {
	if (links.length === 0) {
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

/**
 * Resolves a link to the file that defines its symbol: its `file` taken against the
 * source's workspace folder, or, when it names none, a workspace symbol search.
 */
async function resolveLink(sourceFile: vscode.Uri, link: IDimLink): Promise<IResolvedSymbol | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(sourceFile);
	if (link.file && folder) {
		const file = vscode.Uri.joinPath(folder.uri, link.file);
		if (await exists(file)) {
			return { file, symbol: link.symbol, kind: link.kind };
		}
	}
	// No file, or the generator got the path wrong: search for the symbol instead.
	const found = await resolveBySymbolProviders(sourceFile, unique([link.symbol, lastSegment(link.symbol)]));
	return found && { ...found, kind: link.kind === 'file' ? 'file' : found.kind };
}

/** Whether a file exists. */
async function exists(file: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds a clicked name through the language's symbol providers: among the symbols of
 * the file being viewed first, then across the workspace.
 */
async function resolveBySymbolProviders(sourceFile: vscode.Uri, names: readonly string[]): Promise<IResolvedSymbol | undefined> {
	const local = await findDocumentSymbol(sourceFile, names);
	if (local) {
		return local;
	}
	return findWorkspaceSymbol(sourceFile, names);
}

/** Looks the names up among a file's own symbols, matching `Owner.member` before `member`. */
async function findDocumentSymbol(file: vscode.Uri, names: readonly string[]): Promise<IResolvedSymbol | undefined> {
	let symbols: vscode.DocumentSymbol[] | undefined;
	try {
		symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', file);
	} catch {
		return undefined;
	}
	if (!symbols?.length) {
		return undefined;
	}
	// Flatten to qualified names: a member is `Owner.member`.
	const flat: { readonly qualified: string; readonly symbol: vscode.DocumentSymbol; readonly owner?: vscode.DocumentSymbol }[] = [];
	const walk = (list: readonly vscode.DocumentSymbol[], owner: vscode.DocumentSymbol | undefined, prefix: string): void => {
		for (const symbol of list) {
			const qualified = prefix ? `${prefix}.${symbol.name}` : symbol.name;
			flat.push({ qualified, symbol, owner });
			walk(symbol.children, symbol, qualified);
		}
	};
	walk(symbols, undefined, '');
	for (const name of names) {
		const match = flat.find(entry => entry.qualified === name) ?? flat.find(entry => entry.symbol.name === name);
		if (match) {
			return { file, symbol: match.qualified, kind: linkKindFor(match.symbol.kind, !!match.owner) };
		}
	}
	return undefined;
}

/**
 * Looks the names up across the workspace, preferring a symbol in the source's own
 * workspace folder and, for `Owner.member`, one whose container is that owner.
 */
async function findWorkspaceSymbol(sourceFile: vscode.Uri, names: readonly string[]): Promise<IResolvedSymbol | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(sourceFile);
	for (const name of names) {
		const bare = lastSegment(name);
		const owner = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : undefined;
		let symbols: vscode.SymbolInformation[] | undefined;
		try {
			symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', bare);
		} catch {
			continue;
		}
		const candidates = (symbols ?? []).filter(symbol => symbol.name === bare && (!owner || symbol.containerName === lastSegment(owner)));
		const match = candidates.find(symbol => folder && vscode.workspace.getWorkspaceFolder(symbol.location.uri) === folder) ?? candidates[0];
		if (match) {
			const qualified = match.containerName ? `${match.containerName}.${match.name}` : match.name;
			return { file: match.location.uri, symbol: qualified, kind: linkKindFor(match.kind, !!match.containerName) };
		}
	}
	return undefined;
}

/** Maps a language symbol kind to the kind of Dim view it opens. */
function linkKindFor(kind: vscode.SymbolKind, hasOwner: boolean): DimLinkKind {
	switch (kind) {
		case vscode.SymbolKind.Class:
		case vscode.SymbolKind.Interface:
		case vscode.SymbolKind.Enum:
		case vscode.SymbolKind.Struct:
		case vscode.SymbolKind.TypeParameter:
			return 'class';
		case vscode.SymbolKind.Function:
		case vscode.SymbolKind.Method:
		case vscode.SymbolKind.Constructor:
			return 'function';
		case vscode.SymbolKind.Field:
		case vscode.SymbolKind.Property:
		case vscode.SymbolKind.EnumMember:
			return 'attribute';
		case vscode.SymbolKind.File:
		case vscode.SymbolKind.Module:
		case vscode.SymbolKind.Namespace:
		case vscode.SymbolKind.Package:
			return 'file';
		default:
			// A variable or constant: a class's is state worth a state diagram; a
			// module-level one is shown as part of its file.
			return hasOwner ? 'attribute' : 'file';
	}
}

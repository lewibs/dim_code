/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { clickedNames, findLink, lastSegment, unique } from './dimNames';
import { DimLinkKind, DimLinkView, IDimLink } from './dimRecord';

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
	/** The view its link asks to open on (see {@link IDimLink.view}). */
	readonly view?: DimLinkView;
	/** The 1-based lines its link points at (see {@link IDimLink.line}). */
	readonly line?: number;
	readonly endLine?: number;
}

/**
 * Where a click navigates: the Dim view to open and the view to show in it, or, with
 * a line, the file raw with those lines selected.
 */
export interface IDimDestination {
	/** The source URI to open in the Dim viewer, with a focus fragment for one symbol. */
	readonly uri: vscode.Uri;
	/** The view to show (`raw` or a diagram type), or `undefined` for the README. */
	readonly viewId?: string;
	/** A 1-based line to select in the raw file; set only with `viewId: 'raw'`. */
	readonly line?: number;
	/** The last line to select, when the selection spans several. */
	readonly endLine?: number;
}

/**
 * Works out which Dim view a click in a diagram opens:
 * - an **attribute** opens a view focused on it, on its state diagram;
 * - a **function** or method opens a view focused on it, wherever it is defined;
 * - a **class** defined in another file opens that file's view; one defined in the
 *   file being viewed opens a view focused on it;
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
	// A link to the view already showing goes nowhere; one naming a view or a line of the
	// same file still switches to it.
	const sameView = destination.uri.toString() === source.toString() && destination.viewId === undefined;
	return sameView ? undefined : destination;
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
	const { file, symbol, kind, view, line, endLine } = resolved;
	// A line is in the code itself, so the file opens raw with it selected.
	if (line !== undefined) {
		return { uri: file, viewId: 'raw', line, endLine };
	}
	if (view === 'raw') {
		return { uri: file, viewId: 'raw' };
	}
	// A view the link names replaces the one its kind opens on; `readme` is the default.
	const viewId = view === 'readme' ? undefined : view;
	if (kind === 'file' || !focusSymbolPattern.test(symbol)) {
		return { uri: file, viewId };
	}
	if (kind === 'attribute') {
		return { uri: formatDimFocus(file, kind, symbol), viewId: view ? viewId : 'stateDiagram' };
	}
	if (kind === 'function') {
		return { uri: formatDimFocus(file, kind, symbol), viewId };
	}
	const sameFile = file.toString() === sourceFile.toString();
	return sameFile ? { uri: formatDimFocus(file, kind, symbol), viewId } : { uri: file, viewId };
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
			return { file, symbol: link.symbol, kind: link.kind, view: link.view, line: link.line, endLine: link.endLine };
		}
	}
	// No file, or the generator got the path wrong: search for the symbol instead. Its
	// line no longer applies (it was for the path the link named), but its view does.
	const found = await resolveBySymbolProviders(sourceFile, unique([link.symbol, lastSegment(link.symbol)]));
	return found && { ...found, kind: link.kind === 'file' ? 'file' : found.kind, view: link.view };
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

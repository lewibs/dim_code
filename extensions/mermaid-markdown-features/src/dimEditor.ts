/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getMermaidEditorHtml } from './editorManager';
import { parseDimReadme, parseDimRecord } from './dimRecord';
import { Disposable } from './util/dispose';
import { generateUuid } from './util/uuid';
import { MermaidWebviewManager } from './webviewManager';

export const dimEditorViewType = 'vscode.mermaid-markdown-features.dimEditor';

/**
 * View type tag of the always-present README view, which shows a plain-English
 * overview of the source file. Duplicated as the `readme` id the workbench Dim
 * toggle sends via {@link showDiagramCommand}; keep the two in sync.
 */
const readmeViewType = 'readme';

/**
 * Command the native Dim view toggle (in the workbench editor title bar) runs to
 * switch which diagram this editor shows. Called with the *source file* URI (as a
 * string) and the target diagram type tag. Duplicated as `SHOW_DIAGRAM_COMMAND` in
 * the workbench `dim.contribution`; keep the two in sync.
 */
const showDiagramCommand = '_dim.showDiagram';

/**
 * Workbench command that maps a source file URI to its companion `.dim` record,
 * seeding a placeholder if needed, and returns the record URI as a string (or
 * `undefined` when the file gets no record). The path mapping lives in the
 * workbench because it needs platform-only hashing the extension cannot import.
 */
const resolveRecordCommand = '_dim.resolveRecord';

/**
 * Workbench command a diagram click is forwarded to. It receives the clicked source
 * file URI (as a string) and the {@link IDimNavigateTarget} describing what was clicked,
 * and is responsible for opening the right resource — the source file for a box, or a
 * companion `.dim` view for a member. NOTE: this command is the seam for that
 * navigation logic, which is not implemented yet; until it is, a click is a no-op.
 */
const navigateFromDiagramCommand = '_dim.navigateFromDiagram';

/**
 * What a click in a Dim diagram addresses. Mirrors `DimNavigateTarget` on the webview
 * side (`preview-src/chat/dimClickable.ts`); it is the *shape* of the request, not a
 * resolved resource — the workbench decides which file or `.dim` view it maps to.
 */
interface IDimNavigateTarget {
	readonly kind: 'node' | 'member';
	readonly node: string;
	readonly member?: string;
	readonly memberKind?: 'attribute' | 'method';
	readonly diagramType?: string;
}

/** One switchable view in the editor: the README overview (`text`) or a diagram (`mermaid`). */
interface IDimViewEntry {
	readonly type: string;
	readonly label: string;
	readonly mermaid?: string;
	readonly text?: string;
}

/** An open Dim editor: its panel, the record it reads, its views and the one shown. */
interface IDimView {
	readonly panel: vscode.WebviewPanel;
	readonly recordUri: vscode.Uri | undefined;
	readonly render: () => Promise<void>;
	views: readonly IDimViewEntry[];
	index: number;
}

/**
 * Dim: renders a source file's companion `.dim` record as a full-viewport mermaid
 * diagram. The editor is registered (at `option` priority) for the same source-code
 * resources as the normal text editor, so both views share one tab, path and
 * breadcrumb — exactly like Markdown's text/preview pair. The record itself is a
 * sidecar under the workspace storage home and is never opened as an editor; this
 * provider looks it up via {@link resolveRecordCommand} and reads it directly.
 *
 * The native Dim view toggle in the editor title bar switches a slot between the
 * text editor and this viewer (by reopening the same resource with a different
 * editor override), and between the record's diagrams (via {@link showDiagramCommand}).
 */
export class DimEditorProvider extends Disposable implements vscode.CustomReadonlyEditorProvider {

	/** The open diagram views, keyed by *source file* URI, so the toggle can address them. */
	private readonly _views = new Map<string, IDimView>();

	/**
	 * The diagram type last selected for a source file, kept so a view resolving for the
	 * first time, or re-resolving after being hidden, shows it instead of the first diagram.
	 * Set by the toggle; persists for the session (it is not consumed on read).
	 */
	private readonly _selected = new Map<string, string>();

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) {
		super();

		this._register(vscode.commands.registerCommand(showDiagramCommand, (uri: string, type: string) => this._showDiagram(uri, type)));
	}

	public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { /* nothing to release; the record is read on resolve */ } };
	}

	public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		const diagramId = generateUuid();
		const key = document.uri.toString();

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'chat-webview-out')]
		};

		// Ask the workbench where this file's `.dim` record lives (seeding a placeholder
		// if needed). The record is a sidecar outside the workspace, read via `fs`.
		const recordUriStr = await vscode.commands.executeCommand<string | undefined>(resolveRecordCommand, key);
		const recordUri = recordUriStr ? vscode.Uri.parse(recordUriStr) : undefined;

		const view: IDimView = {
			panel: webviewPanel,
			recordUri,
			views: [],
			index: 0,
			render: async () => {
				view.views = recordUri ? await loadViews(recordUri) : [buildReadmeView(undefined)];
				// Show the type last selected for this source file (restored across hide/show
				// and preserved across live re-renders); otherwise default to the first diagram
				// if the record has one, else the always-present README overview.
				const selectedType = this._selected.get(key);
				const selectedIndex = selectedType ? view.views.findIndex(v => v.type === selectedType) : -1;
				const defaultIndex = view.views.length > 1 ? 1 : 0;
				view.index = selectedIndex >= 0 ? selectedIndex : defaultIndex;
				webviewPanel.webview.html = getMermaidEditorHtml(webviewPanel.webview, this._extensionUri, view.views, diagramId, view.index, /*clickable*/ true);
			}
		};
		this._views.set(key, view);

		// Keep the pan/zoom commands and copy-source working against this webview. The
		// record is a JSON container, so expose the first diagram's mermaid source.
		const disposables: vscode.Disposable[] = [];
		disposables.push(this._webviewManager.registerWebview(diagramId, webviewPanel.webview, '', document.uri.fsPath, 'editor'));

		// A click on a diagram box or member row posts a `dimNavigate` message; forward it
		// to the workbench, which resolves it to a source file or companion `.dim` view.
		disposables.push(webviewPanel.webview.onDidReceiveMessage((message: { type?: string; target?: IDimNavigateTarget }) => {
			if (message?.type === 'dimNavigate' && message.target) {
				void this._navigateFromDiagram(key, message.target);
			}
		}));

		// Watch the record so agent-driven updates re-render the diagram live.
		if (recordUri) {
			const dir = vscode.Uri.joinPath(recordUri, '..');
			const base = recordUri.path.substring(recordUri.path.lastIndexOf('/') + 1);
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, base));
			disposables.push(watcher, watcher.onDidChange(() => view.render()), watcher.onDidCreate(() => view.render()));
		}

		disposables.push(webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				this._webviewManager.setActiveWebview(diagramId);
			}
		}));

		webviewPanel.onDidDispose(() => {
			if (this._views.get(key) === view) {
				this._views.delete(key);
			}
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});

		await view.render();
	}

	/**
	 * Reveals the diagram of the given type for a source file. The selection is always
	 * remembered so that a view resolving (or reopening) shows it in its initial render;
	 * when a view is already open, it is also switched in place (no reload).
	 *
	 * The in-place switch is synchronous (no `await` before `postMessage`) so rapid
	 * toggle clicks reach the webview in click order and the last one wins.
	 *
	 * @param uri The source file URI, as a string.
	 * @param type The target diagram type tag.
	 */
	private _showDiagram(uri: string, type: string): void {
		this._selected.set(uri, type);
		const view = this._views.get(uri);
		if (view) {
			const index = view.views.findIndex(v => v.type === type);
			view.index = index >= 0 ? index : 0;
			view.panel.webview.postMessage({ type: 'dimSelectDiagram', index: view.index });
		}
	}

	/**
	 * Forwards a diagram click to the workbench's navigation command, which maps the
	 * clicked box or member to a source file or companion `.dim` view and opens it.
	 *
	 * The mapping itself lives behind {@link navigateFromDiagramCommand} and is not yet
	 * implemented; the command may therefore be unregistered, so a missing command is
	 * swallowed and the click simply does nothing until the logic is added.
	 *
	 * @param sourceUri The clicked file's source URI, as a string.
	 * @param target What was clicked (a box or a member row).
	 */
	private async _navigateFromDiagram(sourceUri: string, target: IDimNavigateTarget): Promise<void> {
		try {
			await vscode.commands.executeCommand(navigateFromDiagramCommand, sourceUri, target);
		} catch {
			// The resolution command is not registered yet; navigation is a no-op until it is.
		}
	}
}

/**
 * Builds the always-present README view from a record's stored overview, falling
 * back to a "being generated" message when the record has none yet (freshly seeded,
 * or generation has not produced an overview).
 */
function buildReadmeView(readme: string | undefined): IDimViewEntry {
	const text = readme && readme.length > 0
		? readme
		: vscode.l10n.t("The overview for this file is still being generated…");
	return { type: readmeViewType, label: vscode.l10n.t('README'), text };
}

/**
 * Reads a `.dim` record into the list of views the editor can switch between: the
 * README overview first (always present), then one view per diagram the record
 * holds. Returns just the README (with its default message) when the record is
 * missing or unreadable.
 */
async function loadViews(recordUri: vscode.Uri): Promise<IDimViewEntry[]> {
	let content: string | undefined;
	try {
		content = new TextDecoder().decode(await vscode.workspace.fs.readFile(recordUri));
	} catch {
		content = undefined;
	}
	const readme = content !== undefined ? parseDimReadme(content) : undefined;
	const diagrams = content !== undefined ? parseDimRecord(content) : [];
	return [buildReadmeView(readme), ...diagrams.map(d => ({ type: d.type, label: d.label, mermaid: d.mermaid }))];
}

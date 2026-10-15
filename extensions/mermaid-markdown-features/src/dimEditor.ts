/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getMermaidEditorHtml } from './editorManager';
import { IDimDiagramView, parseDimRecord } from './dimRecord';
import { Disposable } from './util/dispose';
import { generateUuid } from './util/uuid';
import { MermaidWebviewManager } from './webviewManager';

export const dimEditorViewType = 'vscode.mermaid-markdown-features.dimEditor';

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

/** An open Dim diagram view: its panel, the record it reads, and the diagram shown. */
interface IDimView {
	readonly panel: vscode.WebviewPanel;
	readonly recordUri: vscode.Uri | undefined;
	readonly render: () => Promise<void>;
	diagrams: readonly IDimDiagramView[];
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

	/** The diagram type to reveal once a not-yet-open view resolves (set by the toggle). */
	private readonly _pending = new Map<string, string>();

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
			diagrams: [],
			index: 0,
			render: async () => {
				view.diagrams = recordUri ? await loadDiagrams(recordUri) : [];
				view.index = view.diagrams.length > 0 ? Math.max(0, Math.min(view.index, view.diagrams.length - 1)) : 0;
				webviewPanel.webview.html = getMermaidEditorHtml(webviewPanel.webview, this._extensionUri, view.diagrams, diagramId, view.index);
			}
		};
		view.index = this._initialIndex(key, view.diagrams);
		this._views.set(key, view);

		// Keep the pan/zoom commands and copy-source working against this webview. The
		// record is a JSON container, so expose the first diagram's mermaid source.
		const disposables: vscode.Disposable[] = [];
		disposables.push(this._webviewManager.registerWebview(diagramId, webviewPanel.webview, '', document.uri.fsPath, 'editor'));

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
	 * The diagram index a freshly resolved view should show: the one the toggle
	 * selected before the editor opened (consumed here), else the first diagram.
	 *
	 * @param key The source file URI used as the view key.
	 * @param diagrams The diagrams the view currently holds.
	 */
	private _initialIndex(key: string, diagrams: readonly IDimDiagramView[]): number {
		const pendingType = this._pending.get(key);
		this._pending.delete(key);
		if (!pendingType) {
			return 0;
		}
		const index = diagrams.findIndex(d => d.type === pendingType);
		return index >= 0 ? index : 0;
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
		this._pending.set(uri, type);
		const view = this._views.get(uri);
		if (view) {
			const index = view.diagrams.findIndex(d => d.type === type);
			view.index = index >= 0 ? index : 0;
			view.panel.webview.postMessage({ type: 'dimSelectDiagram', index: view.index });
		}
	}
}

/** Reads and parses a `.dim` record, or `[]` when it is missing or unreadable. */
async function loadDiagrams(recordUri: vscode.Uri): Promise<IDimDiagramView[]> {
	try {
		const bytes = await vscode.workspace.fs.readFile(recordUri);
		return parseDimRecord(new TextDecoder().decode(bytes));
	} catch {
		return [];
	}
}

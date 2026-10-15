/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getMermaidEditorHtml } from './editorManager';
import { parseDimRecord } from './dimRecord';
import { Disposable } from './util/dispose';
import { generateUuid } from './util/uuid';
import { MermaidWebviewManager } from './webviewManager';

export const dimEditorViewType = 'vscode.mermaid-markdown-features.dimEditor';

/**
 * Command the native Dim view toggle (in the workbench editor title bar) runs to
 * switch which diagram a `.dim` custom editor shows. Called with the record's URI
 * (as a string) and the target diagram {@link DimDiagramType} tag. Duplicated as
 * `SHOW_DIAGRAM_COMMAND` in the workbench `dim.contribution`; keep the two in sync.
 */
const showDiagramCommand = '_dim.showDiagram';

/** An open `.dim` editor: its panel, backing document and the diagram index shown. */
interface IDimView {
	readonly panel: vscode.WebviewPanel;
	readonly document: vscode.TextDocument;
	index: number;
}

/**
 * Dim: renders a `.dim` record as a full-viewport mermaid diagram. A `.dim` record
 * is a JSON container of one or more diagrams; this editor shows one at a time. The
 * record's source file opens as a normal, editable editor — the native Dim view
 * toggle in the editor title bar switches a slot between that file and this diagram
 * viewer, and between the record's diagrams (via {@link showDiagramCommand}).
 * Registered as the default editor for `*.dim`.
 */
export class DimEditorProvider extends Disposable implements vscode.CustomTextEditorProvider {

	/** The open `.dim` editors, keyed by record URI, so the toggle can address them. */
	private readonly _views = new Map<string, IDimView>();

	/** The diagram type to reveal once a not-yet-open record resolves (set by the toggle). */
	private readonly _pending = new Map<string, string>();

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) {
		super();

		this._register(vscode.commands.registerCommand(showDiagramCommand, (uri: string, type: string) => this._showDiagram(uri, type)));
	}

	public resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
		const diagramId = generateUuid();
		const key = document.uri.toString();

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'chat-webview-out')]
		};

		const view: IDimView = { panel: webviewPanel, document, index: this._initialIndex(document, key) };
		this._views.set(key, view);

		const render = () => {
			const diagrams = parseDimRecord(document.getText());
			view.index = Math.max(0, Math.min(view.index, diagrams.length - 1));
			webviewPanel.webview.html = getMermaidEditorHtml(webviewPanel.webview, this._extensionUri, diagrams, diagramId, view.index);
		};

		// Keep the pan/zoom commands and copy-source working against this webview.
		// The record is a JSON container, so expose the first diagram's mermaid
		// source (not the raw JSON) to the manager.
		const registration = this._webviewManager.registerWebview(diagramId, webviewPanel.webview, parseDimRecord(document.getText())[0]?.mermaid ?? '', document.fileName, 'editor');

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === key) {
				render();
			}
		});

		const viewStateSubscription = webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				this._webviewManager.setActiveWebview(diagramId);
			}
		});

		webviewPanel.onDidDispose(() => {
			if (this._views.get(key) === view) {
				this._views.delete(key);
			}
			changeSubscription.dispose();
			viewStateSubscription.dispose();
			registration.dispose();
		});

		render();
	}

	/**
	 * The diagram index a freshly resolved record should show: the one the toggle
	 * selected before the editor opened (consumed here), else the first diagram.
	 *
	 * @param document The record's backing document.
	 * @param key The record URI used as the view key.
	 */
	private _initialIndex(document: vscode.TextDocument, key: string): number {
		const pendingType = this._pending.get(key);
		this._pending.delete(key);
		return pendingType ? this._indexForType(document, pendingType) : 0;
	}

	/** The index of the first diagram with the given type tag, or 0 when none match. */
	private _indexForType(document: vscode.TextDocument, type: string): number {
		const index = parseDimRecord(document.getText()).findIndex(d => d.type === type);
		return index >= 0 ? index : 0;
	}

	/**
	 * Reveals a record's diagram of the given type. The selection is always
	 * remembered so that a record resolving (or reopening) shows it in its initial
	 * render; when a webview for the record is already open, it is also switched in
	 * place (no reload).
	 *
	 * @param uri The record URI, as a string.
	 * @param type The target diagram type tag.
	 */
	private _showDiagram(uri: string, type: string): void {
		this._pending.set(uri, type);
		const view = this._views.get(uri);
		if (view) {
			view.index = this._indexForType(view.document, type);
			view.panel.webview.postMessage({ type: 'dimSelectDiagram', index: view.index });
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getMermaidEditorHtml } from './editorManager';
import { Disposable } from './util/dispose';
import { generateUuid } from './util/uuid';
import { MermaidWebviewManager } from './webviewManager';

export const dimEditorViewType = 'vscode.mermaid-markdown-features.dimEditor';

/**
 * Dim: renders a `.dim` file as a full-viewport mermaid diagram. The entire file
 * content is treated as mermaid source, so opening a `.dim` file auto-renders it
 * as a diagram (like the markdown preview, but with our mermaid renderer) rather
 * than showing raw text. Registered as the default editor for `*.dim`.
 */
export class DimEditorProvider extends Disposable implements vscode.CustomTextEditorProvider {

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) {
		super();
	}

	public resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
		const diagramId = generateUuid();

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'chat-webview-out')]
		};

		const render = () => {
			webviewPanel.webview.html = getMermaidEditorHtml(webviewPanel.webview, this._extensionUri, document.getText(), diagramId);
		};

		// Keep the pan/zoom commands and copy-source working against this webview.
		const registration = this._webviewManager.registerWebview(diagramId, webviewPanel.webview, document.getText(), document.fileName, 'editor');

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				render();
			}
		});

		const viewStateSubscription = webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				this._webviewManager.setActiveWebview(diagramId);
			}
		});

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose();
			viewStateSubscription.dispose();
			registration.dispose();
		});

		render();
	}
}

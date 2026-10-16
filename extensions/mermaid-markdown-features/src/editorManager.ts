/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { generateUuid } from './util/uuid';
import { MermaidWebviewManager } from './webviewManager';
import { escapeHtmlText } from './util/html';
import { Disposable } from './util/dispose';
import { renderMermaidConfigSpan } from './markdownMermaid/config';

export const mermaidEditorViewType = 'vscode.mermaid-markdown-features.preview';

/**
 * One view embedded in the Dim editor webview: either a mermaid diagram (`mermaid`
 * set) or the README overview (`text` set). The native Dim view toggle switches
 * between them by index via a `dimSelectDiagram` message; the webview renders a
 * `text` view as plain prose and a `mermaid` view as a rendered diagram.
 */
export interface IDimWebviewView {
	readonly label: string;
	readonly mermaid?: string;
	readonly text?: string;
	/** Set when `text` is a stand-in because the file has no overview yet. */
	readonly placeholder?: boolean;
}

/**
 * A banner shown at the top of the README view while the file's diagrams are being
 * generated, or after generation failed. Mirrors `DimStatusBanner` on the webview side
 * (`preview-src/chat/mermaidWebview.ts`); keep the two in sync.
 */
export interface IDimStatusBanner {
	readonly kind: 'running' | 'failed';
	readonly message: string;
	readonly detail?: string;
	/** The steps of a running generation, in order, each marked done, current or pending. */
	readonly steps?: readonly IDimStatusStep[];
	/** When the running generation started (epoch ms), for the live elapsed-time counter. */
	readonly startedAt?: number;
	/** The elapsed-time text, with `{0}` standing for the whole seconds elapsed. */
	readonly elapsedLabel?: string;
}

/** One step of a running generation, as listed in the status banner. */
export interface IDimStatusStep {
	readonly label: string;
	readonly state: 'done' | 'current' | 'pending';
}

/**
 * Codicon classes for a step's state. Mirrors `dimStepIconClasses` on the webview side
 * (`preview-src/chat/mermaidWebview.ts`); keep the two in sync.
 */
const dimStepIconClasses: Record<IDimStatusStep['state'], string> = {
	done: 'codicon-check',
	current: 'codicon-loading codicon-modifier-spin',
	pending: 'codicon-circle-large-outline',
};

interface MermaidPreviewState {
	readonly webviewId: string;
	readonly mermaidSource: string;
}

/**
 * Manages mermaid diagram editor panels, ensuring only one editor per diagram.
 */
export class MermaidEditorManager extends Disposable implements vscode.WebviewPanelSerializer {

	private readonly _previews = new Map<string, MermaidPreview>();

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) {
		super();

		this._register(vscode.window.registerWebviewPanelSerializer(mermaidEditorViewType, this));
	}

	/**
	 * Opens a preview for the given diagram
	 *
	 * If a preview already exists for this diagram, it will be revealed instead of creating a new one.
	 */
	public openPreview(mermaidSource: string, title?: string): void {
		const webviewId = getWebviewId(mermaidSource);
		const existingPreview = this._previews.get(webviewId);
		if (existingPreview) {
			existingPreview.reveal();
			return;
		}

		const preview = MermaidPreview.create(
			webviewId,
			mermaidSource,
			title,
			this._extensionUri,
			this._webviewManager,
			vscode.ViewColumn.Active);

		this._registerPreview(preview);
	}

	public async deserializeWebviewPanel(
		webviewPanel: vscode.WebviewPanel,
		state: MermaidPreviewState
	): Promise<void> {
		if (!state?.mermaidSource) {
			webviewPanel.webview.html = this._getErrorHtml();
			return;
		}

		const webviewId = getWebviewId(state.mermaidSource);

		const preview = MermaidPreview.revive(
			webviewPanel,
			webviewId,
			state.mermaidSource,
			this._extensionUri,
			this._webviewManager
		);

		this._registerPreview(preview);
	}

	private _registerPreview(preview: MermaidPreview): void {
		this._previews.set(preview.diagramId, preview);

		preview.onDispose(() => {
			this._previews.delete(preview.diagramId);
		});
	}

	private _getErrorHtml(): string {
		return /* html */`<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Mermaid Preview</title>
				<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
				<style>
					body {
						display: flex;
						justify-content: center;
						align-items: center;
						height: 100vh;
						margin: 0;
					}
				</style>
			</head>
			<body>
				<p>An unexpected error occurred while restoring the Mermaid preview.</p>
			</body>
			</html>`;
	}

	public override dispose(): void {
		super.dispose();

		for (const preview of this._previews.values()) {
			preview.dispose();
		}
		this._previews.clear();
	}
}

class MermaidPreview extends Disposable {

	private readonly _onDisposeEmitter = this._register(new vscode.EventEmitter<void>());
	public readonly onDispose = this._onDisposeEmitter.event;

	public static create(
		diagramId: string,
		mermaidSource: string,
		title: string | undefined,
		extensionUri: vscode.Uri,
		webviewManager: MermaidWebviewManager,
		viewColumn: vscode.ViewColumn
	): MermaidPreview {
		const webviewPanel = vscode.window.createWebviewPanel(
			mermaidEditorViewType,
			title ?? vscode.l10n.t('Mermaid Diagram'),
			viewColumn,
			{
				retainContextWhenHidden: false,
			}
		);

		return new MermaidPreview(webviewPanel, diagramId, mermaidSource, extensionUri, webviewManager);
	}

	public static revive(
		webviewPanel: vscode.WebviewPanel,
		diagramId: string,
		mermaidSource: string,
		extensionUri: vscode.Uri,
		webviewManager: MermaidWebviewManager
	): MermaidPreview {
		return new MermaidPreview(webviewPanel, diagramId, mermaidSource, extensionUri, webviewManager);
	}

	private constructor(
		private readonly _webviewPanel: vscode.WebviewPanel,
		public readonly diagramId: string,
		private readonly _mermaidSource: string,
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) {
		super();

		this._webviewPanel.iconPath = new vscode.ThemeIcon('graph');

		this._webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'chat-webview-out')
			],
		};

		this._webviewPanel.webview.html = this._getHtml();

		// Register with the webview manager
		this._register(this._webviewManager.registerWebview(this.diagramId, this._webviewPanel.webview, this._mermaidSource, undefined, 'editor'));

		this._register(this._webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				this._webviewManager.setActiveWebview(this.diagramId);
			}
		}));

		this._register(this._webviewPanel.onDidDispose(() => {
			this._onDisposeEmitter.fire();
			this.dispose();
		}));
	}

	public reveal(): void {
		this._webviewPanel.reveal();
	}

	public override dispose() {
		this._onDisposeEmitter.fire();

		super.dispose();

		this._webviewPanel.dispose();
	}

	private _getHtml(): string {
		const views: IDimWebviewView[] = [{ label: '', mermaid: this._mermaidSource }];
		return getMermaidEditorHtml(this._webviewPanel.webview, this._extensionUri, views, this.diagramId);
	}
}

/**
 * Builds the full-viewport mermaid webview HTML shared by the diagram preview
 * panel and the `.dim` custom editor. The selected view's content is embedded in
 * the webview and rendered by the `index-editor` script, which also wires up the
 * pan/zoom controls. A view is either a mermaid diagram or the README overview
 * (plain prose). All of the record's views are embedded as JSON so the native Dim
 * view toggle can switch between them in place (via a `dimSelectDiagram` message)
 * without reloading the webview.
 *
 * @param webview The webview the HTML is rendered into (for resource URIs and CSP).
 * @param extensionUri The extension root, used to resolve the webview bundle.
 * @param views The views held by the record (README overview and/or diagrams).
 * @param diagramId The id used to address this webview for pan/zoom commands.
 * @param initialIndex The index of the view to show first (clamped to range).
 * @param clickable Whether diagram boxes and member rows should act as links (the Dim
 * editor turns this on; the plain preview panel leaves it off).
 * @param status The generation progress or failure to show atop the README view, if any.
 * Later changes arrive as `dimStatus` messages.
 */
export function getMermaidEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri, views: readonly IDimWebviewView[], diagramId: string, initialIndex: number = 0, clickable: boolean = false, status?: IDimStatusBanner): string {
	const nonce = generateUuid();

	const mediaRoot = vscode.Uri.joinPath(extensionUri, 'chat-webview-out');
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'index-editor.js'));
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'));
	const togglePanModeLabel = vscode.l10n.t('Toggle Pan Mode');
	const zoomOutLabel = vscode.l10n.t('Zoom Out');
	const zoomInLabel = vscode.l10n.t('Zoom In');
	const resetPanZoomLabel = vscode.l10n.t('Reset Pan and Zoom');

	const index = views.length > 0 ? Math.max(0, Math.min(initialIndex, views.length - 1)) : 0;
	const initial = views[index];
	// A README view carries `text`; a diagram view carries `mermaid`. The initial
	// render shows one or the other; the client swaps between them on toggle.
	const initialIsReadme = initial?.text !== undefined;
	const mermaidSource = initialIsReadme ? '' : (initial?.mermaid ?? '');
	const readmeText = initialIsReadme ? (initial?.text ?? '') : '';
	const readmePlaceholder = initialIsReadme && !!initial?.placeholder;

	// All views, embedded as JSON data so the native toggle can swap the shown view
	// in place. `type="application/json"` is a data block (not executed), and
	// `<`/`>`/`&` are escaped so the payload cannot break out of the script element.
	const viewData = views.length > 0
		? `<script type="application/json" id="dim-views" nonce="${nonce}">${JSON.stringify(views.map(v => ({ label: v.label, mermaid: v.mermaid, text: v.text, placeholder: v.placeholder }))).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`
		: '';

	// The status banner is always in the README so `dimStatus` messages can fill it in;
	// it starts hidden when there is nothing to report. The icon classes mirror
	// `dimStatusIconClasses` on the webview side.
	const statusIcon = status?.kind === 'failed' ? 'codicon-error' : 'codicon-loading codicon-modifier-spin';
	const statusSteps = (status?.steps ?? []).map(step =>
		`<li data-state="${step.state}"><i class="codicon ${dimStepIconClasses[step.state]}" aria-hidden="true"></i><span>${escapeHtmlText(step.label)}</span></li>`).join('');
	const statusElapsed = status?.startedAt !== undefined && status.elapsedLabel
		? status.elapsedLabel.replace('{0}', String(Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000))))
		: '';
	const statusTiming = status?.startedAt !== undefined && status.elapsedLabel
		? ` data-started-at="${status.startedAt}" data-elapsed-label="${escapeHtmlText(status.elapsedLabel)}"`
		: '';
	const statusBanner = `<div class="dim-status" role="status" aria-live="polite"${status ? ` data-kind="${status.kind}"` : ' hidden'}${statusTiming}>
					<i class="codicon ${statusIcon}" aria-hidden="true"></i>
					<div class="dim-status-body">
						<div class="dim-status-message">${escapeHtmlText(status?.message ?? '')}</div>
						<ol class="dim-status-steps">${statusSteps}</ol>
						<div class="dim-status-detail">${escapeHtmlText(status?.detail ?? '')}</div>
						<div class="dim-status-elapsed">${escapeHtmlText(statusElapsed)}</div>
					</div>
				</div>`;

	return /* html */`<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Mermaid Diagram</title>
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:;" />
			<link rel="stylesheet" type="text/css" href="${codiconsUri}">
			<style>
				html, body {
					margin: 0;
					padding: 0;
					height: 100%;
					width: 100%;
					overflow: hidden;
				}
				.mermaid {
					visibility: hidden;
				}
				.mermaid.rendered {
					visibility: visible;
				}
				.mermaid-wrapper {
					height: 100%;
					width: 100%;
				}
				/* Pinned to the viewport rather than laid out after the diagram surface, so
				   the README stays on screen even before the webview script has run. */
				.dim-readme {
					position: absolute;
					inset: 0;
					box-sizing: border-box;
					overflow: auto;
					padding: 24px 32px;
					max-width: 720px;
					margin: 0 auto;
					line-height: 1.6;
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					color: var(--vscode-foreground);
				}
				.dim-readme-text {
					white-space: pre-wrap;
					word-break: break-word;
				}
				.dim-readme-placeholder {
					color: var(--vscode-descriptionForeground);
				}
				/* While the banner reports progress or a failure it replaces the placeholder. */
				.dim-status:not([hidden]) ~ .dim-readme-placeholder {
					display: none;
				}
				.dim-status {
					display: flex;
					align-items: flex-start;
					gap: 8px;
					margin-bottom: 16px;
					padding: 8px 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, transparent);
					background: var(--vscode-editorWidget-background);
				}
				.dim-status[hidden] {
					display: none;
				}
				.dim-status .codicon {
					flex: none;
					line-height: inherit;
				}
				.dim-status[data-kind="failed"] {
					border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
					background: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background));
				}
				.dim-status[data-kind="failed"] .codicon {
					color: var(--vscode-errorForeground);
				}
				.dim-status-body {
					min-width: 0;
					word-break: break-word;
				}
				/* A running banner's spinner sits on the current step, so hide the lead icon. */
				.dim-status[data-kind="running"] > .codicon {
					display: none;
				}
				.dim-status-message {
					font-weight: 600;
				}
				.dim-status-steps {
					list-style: none;
					margin: 6px 0 0;
					padding: 0;
				}
				.dim-status-steps:empty {
					display: none;
				}
				.dim-status-steps li {
					display: flex;
					align-items: center;
					gap: 6px;
				}
				.dim-status-steps li[data-state="pending"] {
					color: var(--vscode-descriptionForeground);
				}
				.dim-status-steps li[data-state="done"] .codicon {
					color: var(--vscode-testing-iconPassed, var(--vscode-foreground));
				}
				.dim-status-detail,
				.dim-status-elapsed {
					color: var(--vscode-descriptionForeground);
				}
				.dim-status-elapsed {
					margin-top: 4px;
					font-variant-numeric: tabular-nums;
				}
				.dim-status-detail:empty,
				.dim-status-elapsed:empty {
					display: none;
				}
				.zoom-controls {
					position: absolute;
					top: 8px;
					right: 8px;
					display: flex;
					gap: 2px;
					z-index: 100;
					background: var(--vscode-editorWidget-background);
					border: 1px solid var(--vscode-editorWidget-border);
					border-radius: 6px;
					padding: 3px;
				}
				.zoom-controls button {
					display: flex;
					align-items: center;
					justify-content: center;
					width: 26px;
					height: 26px;
					background: transparent;
					color: var(--vscode-icon-foreground);
					border: none;
					border-radius: 4px;
					cursor: pointer;
				}
				.zoom-controls button:hover {
					background: var(--vscode-toolbar-hoverBackground);
				}
				.zoom-controls button.active {
					background: var(--vscode-toolbar-activeBackground);
					color: var(--vscode-focusBorder);
				}
				/* Clickable diagram boxes and member rows (Dim editor only). */
				.dim-clickable {
					cursor: pointer;
				}
				.dim-clickable-node:hover {
					filter: brightness(1.12);
				}
				.dim-clickable-member:hover {
					text-decoration: underline;
				}
				/* The wide, transparent hit area over a sequence message's arrow. */
				.dim-hit-area.dim-clickable-member:hover {
					stroke: var(--vscode-focusBorder) !important;
					stroke-opacity: 0.35;
				}
			</style>
		</head>
		<body data-dim-clickable="${clickable}" data-dim-index="${index}" data-vscode-context='${JSON.stringify({ preventDefaultContextMenuItems: true, mermaidWebviewId: diagramId })}' data-vscode-mermaid-webview-id="${diagramId}">
			${renderMermaidConfigSpan()}
			${viewData}
			<div class="zoom-controls"${initialIsReadme ? ' style="display: none;"' : ''}>
				<button class="pan-mode-btn" title="${togglePanModeLabel}" aria-label="${togglePanModeLabel}" aria-pressed="false"><i class="codicon codicon-move" aria-hidden="true"></i></button>
				<button class="zoom-out-btn" title="${zoomOutLabel}" aria-label="${zoomOutLabel}"><i class="codicon codicon-zoom-out" aria-hidden="true"></i></button>
				<button class="zoom-in-btn" title="${zoomInLabel}" aria-label="${zoomInLabel}"><i class="codicon codicon-zoom-in" aria-hidden="true"></i></button>
				<button class="zoom-reset-btn" title="${resetPanZoomLabel}" aria-label="${resetPanZoomLabel}"><i class="codicon codicon-screen-normal" aria-hidden="true"></i></button>
			</div>
			<pre class="mermaid">
				${escapeHtmlText(mermaidSource)}
			</pre>
			<div class="dim-readme"${initialIsReadme ? '' : ' style="display: none;"'}>
				${statusBanner}
				<div class="dim-readme-text${readmePlaceholder ? ' dim-readme-placeholder' : ''}">${escapeHtmlText(readmeText)}</div>
			</div>
			<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
}


/**
 * Generates a unique ID for a diagram based on its content.
 * This ensures the same diagram content always gets the same ID.
 */
function getWebviewId(source: string): string {
	// Simple hash function for generating a content-based ID
	let hash = 0;
	for (let i = 0; i < source.length; i++) {
		const char = source.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash).toString(16);
}

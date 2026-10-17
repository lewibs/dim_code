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
import { IDimChange, IDimLink, IDimTestCase } from './dimRecord';
import { IDimUser } from './dimUsedBy';

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
	/** On the README view of a test file: its tests, shown as a table under the overview. */
	readonly tests?: readonly IDimTestCase[];
	/** On the README view: the files that import the file, listed under "Used By". */
	readonly usedBy?: readonly IDimUser[];
	/** For a diagram: what each of its elements stands for in the code, described on hover. */
	readonly links?: readonly IDimLink[];
	/** For a diagram: the elements the file's changes waiting for review touched, colored by change. */
	readonly changes?: readonly IDimChange[];
	/** For a diagram of a file git does not track yet: all of it is colored as added. */
	readonly isNew?: boolean;
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
 * @param reviewPending Whether the file has changes waiting for review, which shows the
 * review bar (a legend of the change colors, and Accept All / Reject All). Later changes
 * arrive as `dimReview` messages.
 */
export function getMermaidEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri, views: readonly IDimWebviewView[], diagramId: string, initialIndex: number = 0, clickable: boolean = false, status?: IDimStatusBanner, reviewPending: boolean = false): string {
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
		? jsonDataBlock('dim-views', nonce, views.map(v => ({ label: v.label, mermaid: v.mermaid, text: v.text, placeholder: v.placeholder, links: v.links, changes: v.changes, isNew: v.isNew })))
		: '';
	// The words of the card that describes a diagram element on hover (Dim editor only).
	const hoverLabels = clickable ? jsonDataBlock('dim-hover-labels', nonce, {
		class: vscode.l10n.t("Class"),
		function: vscode.l10n.t("Function"),
		attribute: vscode.l10n.t("Attribute"),
		file: vscode.l10n.t("File"),
		added: vscode.l10n.t("Added"),
		changed: vscode.l10n.t("Changed"),
		removed: vscode.l10n.t("Removed"),
		line: vscode.l10n.t("line {0}"),
		lines: vscode.l10n.t("lines {0}–{1}"),
		open: vscode.l10n.t("Click to open"),
	}) : '';

	// A test file's README also lists its tests. The README is the same whichever view
	// is shown first, so the table is rendered once here and never swapped.
	const readmeView = views.find(v => v.text !== undefined);
	const tests = readmeView?.tests;
	const testsSection = tests && tests.length > 0 ? renderTestsSection(tests) : '';
	const usedBy = readmeView?.usedBy;
	const usedBySection = usedBy && usedBy.length > 0 ? renderUsedBySection(usedBy) : '';

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

	// Always in the Dim editor's page (only it reviews changes), so `dimReview` messages can
	// show or hide it. Its buttons post `dimReview` messages back.
	const reviewBar = clickable ? `<div class="dim-review" role="toolbar" aria-label="${escapeHtmlText(vscode.l10n.t("Changes Waiting for Review"))}"${reviewPending ? '' : ' hidden'}>
				<span class="dim-review-title">${escapeHtmlText(vscode.l10n.t("Changes waiting for review"))}</span>
				<span class="dim-review-legend dim-change-added">${escapeHtmlText(vscode.l10n.t("Added"))}</span>
				<span class="dim-review-legend dim-change-changed">${escapeHtmlText(vscode.l10n.t("Changed"))}</span>
				<span class="dim-review-legend dim-change-removed">${escapeHtmlText(vscode.l10n.t("Removed"))}</span>
				<button class="dim-review-accept" data-accept="true" title="${escapeHtmlText(vscode.l10n.t("Accept All Changes in the Workspace"))}"><i class="codicon codicon-check" aria-hidden="true"></i>${escapeHtmlText(vscode.l10n.t("Accept All"))}</button>
				<button class="dim-review-reject" data-accept="false" title="${escapeHtmlText(vscode.l10n.t("Reject All Changes in File"))}"><i class="codicon codicon-discard" aria-hidden="true"></i>${escapeHtmlText(vscode.l10n.t("Reject All"))}</button>
			</div>` : '';

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
				/* A test file's README holds a five-column table, so it gets more room. */
				.dim-readme.dim-readme-wide {
					max-width: 1200px;
				}
				.dim-tests h2 {
					margin: 24px 0 8px;
					font-size: 1.15em;
					font-weight: 600;
				}
				.dim-tests table {
					width: 100%;
					border-collapse: collapse;
					line-height: 1.4;
				}
				.dim-tests th,
				.dim-tests td {
					padding: 6px 8px;
					text-align: left;
					vertical-align: top;
					border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
					word-break: break-word;
				}
				/* A test the changes waiting for review touched, in its change's color (see .dim-change-*). */
				.dim-tests tr.dim-test-change > td {
					background: color-mix(in srgb, var(--dim-change) 14%, transparent);
				}
				.dim-tests tr.dim-test-change > td:first-child {
					box-shadow: inset 3px 0 0 var(--dim-change);
				}
				.dim-tests tr.dim-change-removed > td {
					color: var(--vscode-descriptionForeground);
					text-decoration: line-through;
				}
				.dim-test-badge {
					display: inline-block;
					margin-right: 6px;
					padding: 0 5px;
					border: 1px solid var(--dim-change);
					border-radius: 3px;
					color: var(--dim-change);
					font-size: 0.85em;
					text-decoration: none;
				}
				.dim-tests th {
					font-weight: 600;
					color: var(--vscode-descriptionForeground);
				}
				.dim-tests code {
					font-family: var(--vscode-editor-font-family);
					font-size: 0.95em;
				}
				.dim-tests-suite,
				.dim-tests-none {
					color: var(--vscode-descriptionForeground);
				}
				.dim-tests-suite {
					display: block;
					font-size: 0.9em;
				}
				.dim-tests ul {
					margin: 0;
					padding-left: 20px;
				}
				.dim-used-by h2 {
					margin: 24px 0 8px;
					font-size: 1.15em;
					font-weight: 600;
				}
				.dim-used-by ul {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					margin: 0;
					padding: 0;
					list-style: none;
				}
				.dim-used-by button {
					padding: 2px 8px;
					border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
					border-radius: 4px;
					background: var(--vscode-editorWidget-background);
					color: var(--vscode-textLink-foreground);
					font-family: var(--vscode-editor-font-family);
					font-size: 0.95em;
					cursor: pointer;
				}
				.dim-used-by-more {
					align-self: center;
					color: var(--vscode-descriptionForeground);
				}
				.dim-used-by button:hover {
					border-color: var(--vscode-focusBorder);
					color: var(--vscode-textLink-activeForeground);
				}
				.dim-used-by button:focus-visible {
					outline: 1px solid var(--vscode-focusBorder);
					outline-offset: 1px;
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
				/* Floats over the bottom of the view, like the chat editing review toolbar. */
				.dim-review {
					position: fixed;
					bottom: 16px;
					left: 50%;
					transform: translateX(-50%);
					z-index: 100;
					display: flex;
					align-items: center;
					gap: 10px;
					max-width: calc(100% - 32px);
					box-sizing: border-box;
					padding: 4px 4px 4px 12px;
					background: var(--vscode-editorWidget-background);
					color: var(--vscode-foreground);
					border: 1px solid var(--vscode-editorWidget-border);
					border-radius: 6px;
					box-shadow: var(--vscode-shadow-md, 0 2px 8px var(--vscode-widget-shadow));
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					white-space: nowrap;
				}
				.dim-review[hidden] {
					display: none;
				}
				.dim-review-title {
					color: var(--vscode-descriptionForeground);
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.dim-review-legend {
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.dim-review-legend::before {
					content: '';
					width: 10px;
					height: 10px;
					border-radius: 2px;
					border: 2px solid var(--dim-change);
					background: color-mix(in srgb, var(--dim-change) 22%, var(--vscode-editor-background));
				}
				.dim-review button {
					display: flex;
					align-items: center;
					gap: 4px;
					padding: 3px 8px;
					border: 1px solid var(--vscode-button-border, transparent);
					border-radius: 4px;
					font: inherit;
					cursor: pointer;
				}
				.dim-review button:disabled {
					opacity: 0.6;
					cursor: default;
				}
				.dim-review-accept {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
				}
				.dim-review-accept:hover:not(:disabled) {
					background: var(--vscode-button-hoverBackground);
				}
				.dim-review-reject {
					background: var(--vscode-button-secondaryBackground);
					color: var(--vscode-button-secondaryForeground);
				}
				.dim-review-reject:hover:not(:disabled) {
					background: var(--vscode-button-secondaryHoverBackground);
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
				/* A member row lights up as a whole, like a list item, instead of underlining. */
				:is(.members-group, .methods-group) > .dim-clickable-member:hover {
					text-decoration: none;
				}
				:is(.members-group, .methods-group) > .dim-clickable-member:hover foreignObject > div {
					border-radius: 2px;
					background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
					box-shadow: inset 2px 0 var(--vscode-focusBorder);
					color: var(--vscode-foreground);
				}
				:where(.dim-clickable-node:hover) > .dim-card,
				:where(rect.dim-clickable-node:hover) {
					stroke: var(--vscode-focusBorder) !important;
				}
				/* The wide, transparent hit area over a sequence message's arrow. */
				.dim-hit-area.dim-clickable-member:hover {
					stroke: var(--vscode-focusBorder) !important;
					stroke-opacity: 0.35;
				}
				/* The card that describes the diagram element under the pointer, styled like the
				   editor's own hovers. It never takes the pointer, so it cannot block a click. */
				.dim-hover {
					position: fixed;
					z-index: 20;
					max-width: 360px;
					padding: 6px 10px;
					border: 1px solid var(--vscode-editorHoverWidget-border);
					border-radius: 4px;
					background: var(--vscode-editorHoverWidget-background);
					color: var(--vscode-editorHoverWidget-foreground);
					box-shadow: 0 2px 8px var(--vscode-widget-shadow);
					font-size: var(--vscode-font-size);
					line-height: 1.4;
					pointer-events: none;
				}
				.dim-hover[hidden] {
					display: none;
				}
				.dim-hover-title {
					font-family: var(--vscode-editor-font-family);
					font-weight: 600;
					overflow-wrap: anywhere;
				}
				.dim-hover-meta {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					margin-top: 2px;
					color: var(--vscode-descriptionForeground);
				}
				.dim-hover-change[data-change="added"] { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
				.dim-hover-change[data-change="changed"] { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
				.dim-hover-change[data-change="removed"] { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
				.dim-hover-detail {
					margin-top: 4px;
				}
				.dim-hover-location {
					margin-top: 4px;
					font-family: var(--vscode-editor-font-family);
					font-size: 0.9em;
					color: var(--vscode-textLink-foreground);
					overflow-wrap: anywhere;
				}
				.dim-hover-hint {
					margin-top: 4px;
					font-size: 0.9em;
					color: var(--vscode-descriptionForeground);
				}
				/* The Dim editor draws diagrams like the editor's own widgets: rounded cards with a
				   hairline border on a dotted canvas, quiet edges, and labels on a chip. Every rule
				   is wrapped in :where() so it has no specificity and the change colors below win;
				   !important beats the styles mermaid writes into the diagram. */
				body[data-dim-clickable="true"] {
					--dim-card-background: color-mix(in srgb, var(--vscode-foreground) 5%, var(--vscode-editor-background));
					--dim-card-border: color-mix(in srgb, var(--vscode-foreground) 20%, var(--vscode-editor-background));
					--dim-edge: color-mix(in srgb, var(--vscode-foreground) 45%, var(--vscode-editor-background));
					--dim-muted: var(--vscode-descriptionForeground);
				}
				body[data-dim-clickable="true"] .mermaid-wrapper {
					background-color: var(--vscode-editor-background);
					background-image: radial-gradient(circle, var(--vscode-editorWidget-border, var(--vscode-panel-border)) 1px, transparent 1px);
					background-size: 20px 20px;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.dim-card, rect.actor, .cluster rect, .node > .label-container:is(rect, polygon, path), .node :is(.outer-path, .label-container) :is(path, rect, polygon)) {
					fill: var(--dim-card-background) !important;
					stroke: var(--dim-card-border) !important;
					stroke-width: 1px !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.dim-card, rect.actor, .node > rect.label-container) {
					rx: 8px;
					filter: drop-shadow(0 4px 8px rgb(0 0 0 / 0.25));
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.cluster rect) {
					rx: 8px;
					fill: transparent !important;
					stroke-dasharray: 4 4;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.dim-card-replaced) {
					display: none;
				}
				/* An entity's rows sit on its card, divided by hairlines rather than stripes. */
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.row-rect-odd, .row-rect-even) path {
					fill: transparent !important;
					stroke: none !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.divider path) {
					fill: none !important;
					stroke: var(--dim-card-border) !important;
					stroke-width: 1px !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.label-group .nodeLabel, text.actor, text.actor tspan) {
					font-weight: 600;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.annotation-group .nodeLabel, :is(.members-group, .methods-group) .nodeLabel, .attribute-type .nodeLabel, .attribute-keys .nodeLabel) {
					color: var(--dim-muted) !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.annotation-group .nodeLabel) {
					font-style: italic;
					font-weight: 400;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.edgePaths path, path.relation, path.transition, path.flowchart-link, path.relationshipLine, .messageLine0, .messageLine1) {
					stroke: var(--dim-edge) !important;
					stroke-width: 1.5px !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(marker path, marker circle, .marker) {
					stroke: var(--dim-edge) !important;
				}
				/* An entity relationship's "zero" end is an open ring. */
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(marker circle) {
					fill: var(--vscode-editor-background) !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.actor-line) {
					stroke: var(--dim-card-border) !important;
					stroke-dasharray: 4 4;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.edgeLabel .labelBkg, span.edgeLabel, .edgeLabel rect) {
					background-color: var(--vscode-editor-background) !important;
					fill: var(--vscode-editor-background) !important;
					opacity: 1 !important;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.edgeLabel .labelBkg) {
					border-radius: 4px;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(span.edgeLabel, span.edgeLabel p) {
					color: var(--dim-muted) !important;
					font-size: 12px;
				}
				:where(body[data-dim-clickable="true"] .mermaid svg) :where(.messageText) {
					fill: var(--vscode-foreground) !important;
					stroke: none !important;
				}
				/* What changed since the user last reviewed it, in the theme's git decoration colors. */
				.dim-change-added {
					--dim-change: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
				}
				.dim-change-changed {
					--dim-change: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
				}
				.dim-change-removed {
					--dim-change: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
				}
				.dim-change-node:is(rect, path, polygon, circle, ellipse),
				.dim-change-node :is(rect, path, polygon, circle, ellipse) {
					fill: color-mix(in srgb, var(--dim-change) 22%, var(--vscode-editor-background)) !important;
					stroke: var(--dim-change) !important;
					stroke-width: 2px !important;
				}
				/* A box shows its change in its shape only, so a changed member row inside it still stands out. */
				.dim-change-text:is(text, tspan),
				.dim-change-text :is(text, tspan, span, div, p) {
					color: var(--dim-change) !important;
					fill: var(--dim-change) !important;
				}
				/* Bolding is limited to SVG text: an HTML label's box was sized by Mermaid before
				   the change marks are added, so a wider weight would clip its end. */
				.dim-change-text:is(text, tspan),
				.dim-change-text :is(text, tspan) {
					font-weight: 600;
				}
				.dim-change-removed.dim-change-text :is(text, tspan, span, div, p),
				.dim-change-removed.dim-change-text:is(text, tspan) {
					text-decoration: line-through;
				}
				.dim-change-line {
					stroke: var(--dim-change) !important;
					stroke-width: 2px !important;
				}
			</style>
		</head>
		<body data-dim-clickable="${clickable}" data-dim-index="${index}" data-vscode-context='${JSON.stringify({ preventDefaultContextMenuItems: true, mermaidWebviewId: diagramId })}' data-vscode-mermaid-webview-id="${diagramId}">
			${renderMermaidConfigSpan()}
			${viewData}
			${hoverLabels}
			<div class="zoom-controls"${initialIsReadme ? ' style="display: none;"' : ''}>
				<button class="pan-mode-btn" title="${togglePanModeLabel}" aria-label="${togglePanModeLabel}" aria-pressed="false"><i class="codicon codicon-move" aria-hidden="true"></i></button>
				<button class="zoom-out-btn" title="${zoomOutLabel}" aria-label="${zoomOutLabel}"><i class="codicon codicon-zoom-out" aria-hidden="true"></i></button>
				<button class="zoom-in-btn" title="${zoomInLabel}" aria-label="${zoomInLabel}"><i class="codicon codicon-zoom-in" aria-hidden="true"></i></button>
				<button class="zoom-reset-btn" title="${resetPanZoomLabel}" aria-label="${resetPanZoomLabel}"><i class="codicon codicon-screen-normal" aria-hidden="true"></i></button>
			</div>
			<pre class="mermaid">
				${escapeHtmlText(mermaidSource)}
			</pre>
			<div class="dim-readme${testsSection ? ' dim-readme-wide' : ''}"${initialIsReadme ? '' : ' style="display: none;"'}>
				${statusBanner}
				<div class="dim-readme-text${readmePlaceholder ? ' dim-readme-placeholder' : ''}">${escapeHtmlText(readmeText)}</div>
				${usedBySection}
				${testsSection}
			</div>
			${reviewBar}
			<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
}

/** At most this many files are listed under "Used By"; the rest are counted. */
const maxUsedByShown = 24;

/**
 * Embeds `data` in the page as a JSON data block. `type="application/json"` is not
 * executed, and `<`/`>`/`&` are escaped so the payload cannot break out of the element.
 */
function jsonDataBlock(id: string, nonce: string, data: unknown): string {
	return `<script type="application/json" id="${id}" nonce="${nonce}">${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`;
}

/**
 * Renders the files that import the file as a row of buttons, each opening that file in
 * Dim. A button shows the file's name and its full path on hover, as two files in
 * different folders can share a name.
 */
function renderUsedBySection(usedBy: readonly IDimUser[]): string {
	const heading = `<h2>${escapeHtmlText(vscode.l10n.t("Used By"))}</h2>`;
	const items = usedBy.slice(0, maxUsedByShown).map(user => {
		const name = user.label.slice(user.label.lastIndexOf('/') + 1);
		return `<li><button type="button" data-uri="${escapeHtmlText(user.uri)}" title="${escapeHtmlText(user.label)}">${escapeHtmlText(name)}</button></li>`;
	});
	if (usedBy.length > maxUsedByShown) {
		items.push(`<li class="dim-used-by-more">${escapeHtmlText(vscode.l10n.t("and {0} more", usedBy.length - maxUsedByShown))}</li>`);
	}
	return `<section class="dim-used-by">${heading}<ul>${items.join('')}</ul></section>`;
}

/**
 * Renders a test file's tests as a table (test, what it checks, input, expected
 * result, mocks) followed by a "Validation" summary of what the tests mock, so a
 * reader can tell at a glance how much of the real code the tests exercise. Tests
 * the changes waiting for review touched are colored like changed diagram elements.
 */
function renderTestsSection(tests: readonly IDimTestCase[]): string {
	const heading = `<h2>${escapeHtmlText(vscode.l10n.t("Tests"))}</h2>`;
	const noMocks = vscode.l10n.t("None");
	const changeLabels = { added: vscode.l10n.t("Added"), changed: vscode.l10n.t("Changed"), removed: vscode.l10n.t("Removed") };
	const rows = tests.map(test => {
		const suite = test.suite ? `<span class="dim-tests-suite">${escapeHtmlText(test.suite)}</span>` : '';
		const mocks = test.mocks.length > 0
			? test.mocks.map(mock => `<code>${escapeHtmlText(mock)}</code>`).join(', ')
			: `<span class="dim-tests-none">${escapeHtmlText(noMocks)}</span>`;
		// The change is also spelled out, so it does not rest on color alone.
		const badge = test.change ? `<span class="dim-test-badge">${escapeHtmlText(changeLabels[test.change])}</span>` : '';
		const rowClass = test.change ? ` class="dim-test-change dim-change-${test.change}"` : '';
		return `<tr${rowClass}><td>${badge}${suite}${escapeHtmlText(test.name)}</td><td>${escapeHtmlText(test.checks)}</td><td>${escapeHtmlText(test.input)}</td><td>${escapeHtmlText(test.expected)}</td><td>${mocks}</td></tr>`;
	}).join('');
	const header = [vscode.l10n.t("Test"), vscode.l10n.t("What It Checks"), vscode.l10n.t("Input"), vscode.l10n.t("Expected"), vscode.l10n.t("Mocked")]
		.map(label => `<th scope="col">${escapeHtmlText(label)}</th>`).join('');
	const table = `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
	return `<section class="dim-tests">${heading}${table}${renderValidation(tests)}</section>`;
}

/**
 * Summarizes what a test file's tests mock: each mocked dependency with how many
 * tests replace it, and how many tests run the real code throughout.
 */
function renderValidation(allTests: readonly IDimTestCase[]): string {
	// Removed tests are listed in the table to show what went away, but no longer run.
	const tests = allTests.filter(test => test.change !== 'removed');
	const heading = `<h2>${escapeHtmlText(vscode.l10n.t("Validation"))}</h2>`;
	const usage = new Map<string, number>();
	for (const test of tests) {
		for (const mock of new Set(test.mocks)) {
			usage.set(mock, (usage.get(mock) ?? 0) + 1);
		}
	}
	if (usage.size === 0) {
		return `${heading}<p>${escapeHtmlText(vscode.l10n.t("Nothing is mocked: all {0} tests run against the real code.", tests.length))}</p>`;
	}
	const items = [...usage].map(([mock, count]) =>
		`<li><code>${escapeHtmlText(mock)}</code> ${escapeHtmlText(vscode.l10n.t("is mocked in {0} of {1} tests", count, tests.length))}</li>`).join('');
	const unmocked = tests.filter(test => test.mocks.length === 0).length;
	const realCode = vscode.l10n.t("{0} of {1} tests use no mocks and run against the real code.", unmocked, tests.length);
	return `${heading}<ul>${items}</ul><p>${escapeHtmlText(realCode)}</p>`;
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

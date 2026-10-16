/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getMermaidEditorHtml, IDimStatusBanner } from './editorManager';
import { DimGenerationStatus, DimGenerationStep } from './dimGenerate';
import { dimFocusSymbol, IDimNavigateTarget, resolveDimNavigation } from './dimNavigate';
import { IDimLink, parseDimReadme, parseDimRecord } from './dimRecord';
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
 * Workbench command that opens a source URI (a whole file, or one symbol of it via a
 * focus fragment) in this diagram viewer, optionally on a given view. Run once a click
 * in a diagram has been resolved to the Dim view it opens. Duplicated as
 * `OPEN_DIM_COMMAND` in the workbench `dim.contribution`; keep the two in sync.
 */
const openDimCommand = '_dim.openDim';

/**
 * The generator's steps as listed in the README's progress banner, in the order it runs
 * them. Each `id` is a {@link DimGenerationStep} the generator announces.
 */
const generationSteps: readonly { readonly id: DimGenerationStep; readonly label: () => string }[] = [
	{ id: 'reading', label: () => vscode.l10n.t("Read the file and its imports") },
	{ id: 'claude', label: () => vscode.l10n.t("Generating diagrams") },
	{ id: 'saving', label: () => vscode.l10n.t("Save the overview and diagrams") },
];

/** One switchable view in the editor: the README overview (`text`) or a diagram (`mermaid`). */
interface IDimViewEntry {
	readonly type: string;
	readonly label: string;
	readonly mermaid?: string;
	readonly text?: string;
	/** Set on the README view when the file has no overview yet. */
	readonly placeholder?: boolean;
	/** For a diagram: what each of its clickable elements stands for in the code. */
	readonly links?: readonly IDimLink[];
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
 * sidecar in the workspace `.dim` folder and is never opened as an editor; this
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
		private readonly _webviewManager: MermaidWebviewManager,
		private readonly _generationStatus: DimGenerationStatus
	) {
		super();

		this._register(vscode.commands.registerCommand(showDiagramCommand, (uri: string, type: string) => this._showDiagram(uri, type)));
		// Show generation progress and failures as they happen. The banner is updated in
		// place (no reload), so the shown view and its pan/zoom are left alone.
		this._register(this._generationStatus.onDidChange(uri => {
			const view = this._views.get(uri);
			if (view) {
				view.panel.webview.postMessage({ type: 'dimStatus', status: this._statusBanner(uri, view) });
			}
		}));
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

		// A view focused on one symbol of the file is titled after it, so its tab can be
		// told apart from the whole file's.
		const focusSymbol = dimFocusSymbol(document.uri);
		if (focusSymbol) {
			const fileName = document.uri.path.substring(document.uri.path.lastIndexOf('/') + 1);
			webviewPanel.title = vscode.l10n.t("{0} › {1}", fileName, focusSymbol);
		}

		// A big-picture record is opened directly and is its own record. For a source file,
		// ask the workbench where its `.dim` record lives (seeding an empty one if needed).
		// The record is in the workspace's `.dim` folder, read via `fs`. If the lookup
		// fails, still render (an empty README) rather than leaving a blank page.
		let recordUriStr: string | undefined;
		if (isBigPictureRecord(document.uri)) {
			recordUriStr = key;
		} else {
			try {
				recordUriStr = await vscode.commands.executeCommand<string | undefined>(resolveRecordCommand, key);
			} catch {
				recordUriStr = undefined;
			}
		}
		const recordUri = recordUriStr ? vscode.Uri.parse(recordUriStr) : undefined;

		const view: IDimView = {
			panel: webviewPanel,
			recordUri,
			views: [],
			index: 0,
			render: async () => {
				view.views = recordUri ? await loadViews(recordUri) : [buildReadmeView(undefined)];
				// Show the type last selected for this source file (restored across hide/show
				// and preserved across live re-renders); otherwise open on the always-present
				// README overview, which is first.
				const selectedType = this._selected.get(key);
				const selectedIndex = selectedType ? view.views.findIndex(v => v.type === selectedType) : -1;
				view.index = selectedIndex >= 0 ? selectedIndex : 0;
				webviewPanel.webview.html = getMermaidEditorHtml(webviewPanel.webview, this._extensionUri, view.views, diagramId, view.index, /*clickable*/ true, this._statusBanner(key, view));
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
	 * Builds the README's status banner for a source file from its latest generation
	 * run: progress while Claude works, or why the run failed. `undefined` when there
	 * is nothing to report.
	 *
	 * @param uri The source file URI, as a string.
	 * @param view The open editor, used to tell a first generation from an update.
	 */
	private _statusBanner(uri: string, view: IDimView): IDimStatusBanner | undefined {
		const state = this._generationStatus.get(uri);
		if (!state) {
			return undefined;
		}
		if (state.kind === 'running') {
			const hasOverview = view.views.length > 0 && !view.views[0].placeholder;
			// Before the generator announces its first step, show the first as current.
			const current = Math.max(0, generationSteps.findIndex(step => step.id === state.step));
			return {
				kind: 'running',
				message: hasOverview
					? vscode.l10n.t("Updating the overview and diagrams for this file's latest changes…")
					: vscode.l10n.t("Generating an overview and diagrams for this file…"),
				steps: generationSteps.map((step, index) => ({
					label: step.label(),
					state: index < current ? 'done' : index === current ? 'current' : 'pending',
				})),
				startedAt: state.startedAt,
				elapsedLabel: vscode.l10n.t("{0}s elapsed"),
			};
		}
		return {
			kind: 'failed',
			message: vscode.l10n.t("Couldn't generate the overview and diagrams for this file."),
			detail: vscode.l10n.t("{0} Reopen this file to try again.", state.message),
		};
	}

	/**
	 * Opens the Dim view a diagram click names (see {@link resolveDimNavigation} for the
	 * rules), using the links the record stores for the clicked diagram. A click that
	 * names no code says so in the status bar.
	 *
	 * @param sourceUri The URI the clicked view shows, as a string.
	 * @param target What was clicked (a box, a member row or a message).
	 */
	private async _navigateFromDiagram(sourceUri: string, target: IDimNavigateTarget): Promise<void> {
		const view = this._views.get(sourceUri);
		const shown = view?.views[view.index];
		const otherLinks = view?.views.filter(entry => entry !== shown).flatMap(entry => entry.links ?? []) ?? [];
		const destination = await resolveDimNavigation(vscode.Uri.parse(sourceUri), shown?.links ?? [], otherLinks, target);
		if (!destination) {
			const clicked = target.member || target.node;
			if (clicked) {
				vscode.window.setStatusBarMessage(vscode.l10n.t("Dim: No code found for \"{0}\".", clicked), 4000);
			}
			return;
		}
		await vscode.commands.executeCommand(openDimCommand, destination.uri.toString(), destination.viewId);
	}
}

/**
 * Whether a URI is a big-picture record: a `.dim` record under a workspace's
 * `.dim/big_picture/` folder that answers a question spanning several files, rather
 * than describing one source file. Mirrors `isDimBigPictureRecord` in the platform's
 * `dimHookStorage.ts` and this extension's `.dim` editor selector; keep them in sync.
 */
function isBigPictureRecord(uri: vscode.Uri): boolean {
	return uri.path.endsWith('.dim') && uri.path.includes('/.dim/big_picture/');
}

/**
 * Builds the always-present README view from a record's stored overview. When the
 * record has none yet the view is an empty placeholder; the status banner fills it
 * while a generation run is in progress or has failed.
 */
function buildReadmeView(readme: string | undefined): IDimViewEntry {
	if (readme && readme.length > 0) {
		return { type: readmeViewType, label: vscode.l10n.t('README'), text: readme };
	}
	return { type: readmeViewType, label: vscode.l10n.t('README'), text: '', placeholder: true };
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
	return [buildReadmeView(readme), ...diagrams.map(d => ({ type: d.type, label: d.label, mermaid: d.mermaid, links: d.links }))];
}

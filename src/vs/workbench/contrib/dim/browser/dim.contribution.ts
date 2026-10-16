/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DimDiagramType, dimDiagramTypes } from '../../../../platform/agentHost/common/dimDiagramTypes.js';
import { DIM_EDITOR_VIEW_TYPE, dimHookStorageDir, IDimDiagram, isDimBigPictureRecord, isDimCodeFile, parseDimFocus, parseDimRecord, seedDimRecord, syncDimRecordsGitignore } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorPaneSelectionChangeReason } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IDimDiagramViewOption, IDimDiagramViewService } from '../../../services/dimDiagram/common/dimDiagramView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { CustomEditorInput } from '../../customEditor/browser/customEditorInput.js';
import { customEditorViewOptions } from '../../customEditor/common/customEditorView.js';

/**
 * Command run by the Dim diagram viewer to switch the currently shown diagram.
 * Registered by the `mermaid-markdown-features` extension; the Dim view toggle
 * calls it with the source file's URI and the diagram type to reveal.
 */
const SHOW_DIAGRAM_COMMAND = '_dim.showDiagram';

/**
 * Whether git ignores Dim's diagram records, via a `.gitignore` that Dim keeps in each
 * workspace's `.dim` folder. Turning it off removes that file so the records can be
 * committed with the code.
 */
const DIM_DIAGRAMS_GITIGNORE_SETTING = 'dim.diagrams.gitignore';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dim',
	title: localize('dimConfigurationTitle', "Dim"),
	type: 'object',
	properties: {
		[DIM_DIAGRAMS_GITIGNORE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.RESOURCE,
			markdownDescription: localize('dim.diagrams.gitignore', "Keep a `.gitignore` in the workspace's `.dim` folder so git ignores Dim's diagrams and overviews. Turn this off to delete that file and commit them with your code."),
		},
	},
});

/**
 * Command the Dim diagram viewer calls to map a source file URI to its companion
 * `.dim` record, seeding a placeholder if needed. Returns the record URI as a
 * string, or `undefined` for files that get no record. Registered here because the
 * path mapping needs platform-only hashing the extension cannot import.
 */
const RESOLVE_RECORD_COMMAND = '_dim.resolveRecord';

/**
 * Command the `mermaid-markdown-features` extension registers to (re)generate a
 * source file's `.dim` record, picking the diagram type that fits its code. Fired
 * here on file open (after seeding the placeholder) so a file whose record is
 * missing or stale is brought up to date. It runs in the extension host because
 * generation shells out to a child process the workbench renderer cannot spawn;
 * the generator itself no-ops when the record is already current.
 */
const GENERATE_RECORD_COMMAND = '_dim.generateRecord';

/**
 * Command the `mermaid-markdown-features` extension registers to bring a workspace
 * folder's `.dim` records in line with its git HEAD: once a file's changes are committed,
 * its diagrams drop their change colors and removed elements. Fired here on startup and
 * whenever the folder's HEAD moves. It runs in the extension host because it shells out
 * to git. Duplicated as `syncDiffsCommand` in the extension's `dimDiff`; keep the two in sync.
 */
const SYNC_DIFFS_COMMAND = '_dim.syncDiffs';

/**
 * How long to wait after HEAD moves before syncing, so the burst of writes one git
 * operation makes (or a rebase's many commits) causes a single sync.
 */
const SYNC_DIFFS_DELAY = 1000;

/**
 * Command the diagram viewer runs when a click in a diagram resolves to another Dim
 * view: it opens the given source URI (a whole file, or one symbol of it via a focus
 * fragment, see `parseDimFocus`) in the diagram viewer, on the given view when one is
 * named (e.g. a stateful attribute's `stateDiagram`). Duplicated as `openDimCommand`
 * in the `mermaid-markdown-features` extension's `dimEditor`; keep the two in sync.
 */
const OPEN_DIM_COMMAND = '_dim.openDim';

/**
 * Absolute URI of the bundled per-file diagram generator, handed to
 * {@link GENERATE_RECORD_COMMAND} so the extension host spawns the same script the
 * agent hook uses.
 */
const DIM_GENERATOR_URI = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/generateDimDiagram.sh');

/** The diagram types in the order they appear in the view picker. */
const dimDiagramTypeOrder: readonly DimDiagramType[] = dimDiagramTypes;

/** Localized title for each diagram kind's view in the picker. */
function dimViewTitle(type: DimDiagramType): string {
	switch (type) {
		case DimDiagramType.Class: return localize('dim.view.structure', "Structure");
		case DimDiagramType.Sequence: return localize('dim.view.behavior', "Behavior");
		case DimDiagramType.Flowchart: return localize('dim.view.logic', "Logic");
		case DimDiagramType.StatefulParameter: return localize('dim.view.states', "States");
		case DimDiagramType.Entity: return localize('dim.view.data', "Data");
	}
}

/** The command id that switches the active editor to a given diagram view. */
function diagramCommandId(type: DimDiagramType): string {
	return `dim.view.${type}`;
}

/** The command id that switches the active editor to the raw, editable source file. */
const RAW_COMMAND_ID = 'dim.view.raw';

/** Localized title for the raw-source view, shared by the toggle button and the picker. */
function rawViewTitle(): string {
	return localize('dim.view.raw', "Raw");
}

/**
 * View id of the always-present README view, which shows a plain-English overview
 * of the source file. Duplicated as `readmeViewType` in the `mermaid-markdown-features`
 * extension's `dimEditor`, which cannot import workbench sources; keep the two in sync.
 */
const README_VIEW_ID = 'readme';

/** The command id that switches the active editor to the README overview view. */
const README_COMMAND_ID = 'dim.view.readme';

/** Localized title for the README overview view, shared by the toggle button and the picker. */
function readmeViewTitle(): string {
	return localize('dim.view.readme', "README");
}

/**
 * The Dim context resolved for an editor: its source file, the diagrams the file's
 * companion `.dim` record holds, and whether the diagram viewer (rather than the
 * text editor) is currently showing.
 */
interface IDimEditorContext {
	readonly sourceUri: URI;
	readonly diagrams: readonly IDimDiagram[];
	readonly recordActive: boolean;
}

/**
 * Drives Dim view switching. A source file opens in the Dim diagram viewer, on its
 * README view; the viewer is registered (`default` priority) for the *same* source
 * resource as the normal, editable text editor (which an open targeting a line, such
 * as go to definition, still gets), so both share one tab, path and breadcrumb — just
 * like Markdown's text/preview pair. This service reads the file's companion `.dim` record, registers
 * the commands that switch the same editor slot between the text editor and each
 * diagram, and exposes {@link getViewOptions} so the breadcrumb editor-type picker can
 * list the available views as a dropdown.
 */
class DimDiagramViewService extends Disposable implements IDimDiagramViewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeViewOptions = this._register(new Emitter<void>());
	readonly onDidChangeViewOptions: Event<void> = this._onDidChangeViewOptions.event;

	/**
	 * Follows the view the active diagram viewer shows, so the picker and the viewer
	 * change together. The viewer's editor input holds that view (see
	 * {@link CustomEditorInput.view}); it is the one record of which view is showing.
	 */
	private readonly _activeViewListener = this._register(new MutableDisposable());

	/**
	 * The diagrams a source file's record holds, keyed by source URI, so the breadcrumb
	 * picker can list its views synchronously. Populated as editors are resolved.
	 */
	private readonly _diagramsBySource = new Map<string, readonly IDimDiagram[]>();

	/** Guards against out-of-order async updates when the active editor changes quickly. */
	private _updateSeq = 0;

	/**
	 * Source files whose `.dim` record is currently being (re)generated, keyed by source
	 * URI, so a burst of resolves for the same file while generation is in flight only
	 * spawns one generator run. The generator itself is the real freshness gate.
	 */
	private readonly _generating = new Set<string>();

	/** Each workspace folder's watch on its git HEAD, keyed by folder URI. */
	private readonly _commitWatchers = this._register(new DisposableMap<string>());

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		for (const type of dimDiagramTypeOrder) {
			this._register(CommandsRegistry.registerCommand(diagramCommandId(type), () => this._showView(type)));
		}
		this._register(CommandsRegistry.registerCommand(README_COMMAND_ID, () => this._showView(README_VIEW_ID)));
		this._register(CommandsRegistry.registerCommand(RAW_COMMAND_ID, () => this._showRaw()));

		// The diagram viewer (in the extension host) asks us where a file's record lives;
		// the hashing that maps a source file to its sidecar is platform-only, so it stays
		// here and the extension reads the resolved record itself.
		this._register(CommandsRegistry.registerCommand(RESOLVE_RECORD_COMMAND, (_accessor, sourceUriStr: string) => this._resolveRecordUri(sourceUriStr)));
		this._register(CommandsRegistry.registerCommand(OPEN_DIM_COMMAND, (_accessor, sourceUriStr: string, viewId?: string) => this._openDim(URI.parse(sourceUriStr), viewId)));

		this._register(this._editorService.onDidActiveEditorChange(() => this._update()));
		this._update();

		// Keep each records folder's `.gitignore` in line with the setting: on startup,
		// when the setting changes, and for newly added workspace folders.
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DIM_DIAGRAMS_GITIGNORE_SETTING)) {
				this._syncRecordsGitignore(this._contextService.getWorkspace().folders.map(folder => folder.uri));
			}
		}));
		this._register(this._contextService.onDidChangeWorkspaceFolders(e => this._syncRecordsGitignore(e.added.map(folder => folder.uri))));
		this._syncRecordsGitignore(this._contextService.getWorkspace().folders.map(folder => folder.uri));

		// Reset the change colors of committed files: watch each folder's git HEAD.
		this._register(this._contextService.onDidChangeWorkspaceFolders(e => {
			for (const folder of e.removed) {
				this._commitWatchers.deleteAndDispose(folder.uri.toString());
			}
			for (const folder of e.added) {
				this._watchCommits(folder.uri);
			}
		}));
		for (const folder of this._contextService.getWorkspace().folders) {
			this._watchCommits(folder.uri);
		}
	}

	/**
	 * Syncs a workspace folder's records with its git HEAD (see {@link SYNC_DIFFS_COMMAND})
	 * now, to catch commits made while Dim was closed, and again each time HEAD moves.
	 * HEAD's reflog (`.git/logs/HEAD`) gains a line on every commit, checkout and reset,
	 * so it is the one file to watch. A folder with no records folder is skipped.
	 */
	private _watchCommits(folder: URI): void {
		const store = new DisposableStore();
		this._commitWatchers.set(folder.toString(), store);
		const sync = store.add(new RunOnceScheduler(() => {
			const recordsUri = dimHookStorageDir(folder);
			void (async () => {
				if (await this._fileService.exists(recordsUri)) {
					await this._commandService.executeCommand(SYNC_DIFFS_COMMAND, { folderUri: folder.toString(), recordsUri: recordsUri.toString() });
				}
			})();
		}, SYNC_DIFFS_DELAY));
		const headLog = joinPath(folder, '.git', 'logs', 'HEAD');
		const watcher = store.add(this._fileService.createWatcher(headLog, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(e => {
			if (e.contains(headLog)) {
				sync.schedule();
			}
		}));
		sync.schedule();
	}

	/** Whether {@link DIM_DIAGRAMS_GITIGNORE_SETTING} asks git to ignore a workspace folder's records. */
	private _ignoreRecordsInGit(workspaceFolder: URI): boolean {
		return this._configurationService.getValue<boolean>(DIM_DIAGRAMS_GITIGNORE_SETTING, { resource: workspaceFolder }) !== false;
	}

	/**
	 * Adds or removes the `.gitignore` in the given workspace folders' records folders to
	 * match {@link DIM_DIAGRAMS_GITIGNORE_SETTING}. Folders with no records folder yet are
	 * skipped; seeding the first record applies the setting there.
	 */
	private _syncRecordsGitignore(workspaceFolders: readonly URI[]): void {
		for (const folder of workspaceFolders) {
			void (async () => {
				if (await this._fileService.exists(dimHookStorageDir(folder))) {
					await syncDimRecordsGitignore(this._fileService, folder, this._ignoreRecordsInGit(folder));
				}
			})();
		}
	}

	/** Reads a text file's contents, or `undefined` when it does not exist / cannot be read. */
	private async _readText(uri: URI): Promise<string | undefined> {
		try {
			const content = await this._fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * Maps a source file URI to its companion `.dim` record, seeding an empty record when
	 * none exists yet, and returns the record URI as a string. Returns `undefined` for
	 * files that get no record (non-code files, or files outside the workspace). Backs
	 * {@link RESOLVE_RECORD_COMMAND}.
	 */
	private async _resolveRecordUri(sourceUriStr: string): Promise<string | undefined> {
		const sourceUri = URI.parse(sourceUriStr);
		const folder = this._contextService.getWorkspaceFolder(sourceUri);
		if (!folder || !isDimCodeFile(sourceUri)) {
			return undefined;
		}
		const recordUri = await seedDimRecord(this._fileService, folder.uri, sourceUri, this._ignoreRecordsInGit(folder.uri));
		if (recordUri) {
			// Bring the record up to date for this file's current code (no-op when it is
			// already current). Fire-and-forget: the empty record is already in place, the
			// toggle refreshes when generation finishes, and the diagram viewer re-renders
			// from its own watcher when the record changes.
			this._generateRecord(sourceUri, folder.uri, recordUri);
		}
		return recordUri?.toString();
	}

	/**
	 * Asks the extension host to (re)generate the `.dim` record for a source file, so a
	 * file opened with a missing or stale record gets a diagram that matches its current
	 * code. De-duplicated per source while a run is in flight; the generator script is the
	 * authority on whether work is actually needed (it skips an unchanged file).
	 */
	private _generateRecord(sourceUri: URI, folderUri: URI, recordUri: URI): void {
		const key = sourceUri.toString();
		if (this._generating.has(key)) {
			return;
		}
		const relPath = relativePath(folderUri, sourceUri);
		if (!relPath) {
			return;
		}
		this._generating.add(key);
		const focus = parseDimFocus(sourceUri);
		Promise.resolve(this._commandService.executeCommand(GENERATE_RECORD_COMMAND, {
			scriptUri: DIM_GENERATOR_URI.toString(),
			sourceUri: sourceUri.toString(),
			recordUri: recordUri.toString(),
			relPath,
			focusKind: focus?.kind,
			focusSymbol: focus?.symbol,
		})).finally(() => {
			this._generating.delete(key);
			// The generator may have written a diagram chosen from the file's code (or
			// left the record empty): refresh the toggle so that diagram appears without
			// re-activating the editor.
			void this._refreshFromRecord(sourceUri, recordUri);
		});
	}

	/**
	 * Refreshes the toggle from a source file's `.dim` record on disk after the generator
	 * runs, so a freshly generated diagram (or a record left empty) is reflected without
	 * waiting for the next editor activation. Does nothing when that file is no longer the
	 * active editor. Unlike {@link _update} it neither seeds nor regenerates, so it cannot
	 * re-trigger generation.
	 */
	private async _refreshFromRecord(sourceUri: URI, recordUri: URI): Promise<void> {
		const ref = this._ref(this._editorService.activeEditor);
		if (!ref || ref.sourceUri.toString() !== sourceUri.toString()) {
			return; // the user moved on; the next activation will resolve it
		}
		const content = await this._readText(recordUri);
		const diagrams = content === undefined ? [] : parseDimRecord(content);
		const key = sourceUri.toString();
		if (diagrams.length > 0) {
			this._diagramsBySource.set(key, diagrams);
		} else {
			this._diagramsBySource.delete(key);
		}
		this._onDidChangeViewOptions.fire();
	}

	/**
	 * Resolves, synchronously and without any file I/O, the source file an editor shows
	 * and whether the diagram viewer (rather than the text editor) is active. Returns
	 * `undefined` for editors that get no Dim toggle (non-code files, or files outside
	 * the workspace).
	 *
	 * This is the switch actions' fast path: choosing a diagram must not wait on an async
	 * read that could reorder against a rapid second click and leave the wrong diagram
	 * showing. Diagram contents (for the context keys) still come from {@link _resolve}.
	 */
	private _ref(editor: EditorInput | null | undefined): { readonly sourceUri: URI; readonly recordActive: boolean; readonly bigPicture: boolean } | undefined {
		const sourceUri = editor?.resource;
		const bigPicture = sourceUri && this._isBigPicture(sourceUri);
		if (!editor || !sourceUri || bigPicture === undefined) {
			return undefined;
		}
		return { sourceUri, recordActive: editor.editorId === DIM_EDITOR_VIEW_TYPE, bigPicture };
	}

	/**
	 * Whether a file Dim shows in the diagram viewer is a big-picture record (which is
	 * its own record, so Raw shows the record's JSON) rather than a code file with a
	 * companion record. `undefined` for files the viewer does not show: other files, and
	 * files outside the workspace.
	 */
	private _isBigPicture(uri: URI): boolean | undefined {
		if (!this._contextService.getWorkspaceFolder(uri)) {
			return undefined;
		}
		if (isDimBigPictureRecord(this._contextService.getWorkspace().folders.map(folder => folder.uri), uri)) {
			return true;
		}
		return isDimCodeFile(uri) ? false : undefined;
	}

	/**
	 * Resolves the Dim context for an editor by reading its source file's companion
	 * `.dim` record (seeding an empty record when none exists yet). Returns `undefined`
	 * when the file has no record with diagrams, so the toggle stays hidden.
	 */
	private async _resolve(editor: EditorInput | null | undefined): Promise<IDimEditorContext | undefined> {
		const ref = this._ref(editor);
		if (!ref) {
			return undefined;
		}
		const recordUriStr = ref.bigPicture ? ref.sourceUri.toString() : await this._resolveRecordUri(ref.sourceUri.toString());
		if (!recordUriStr) {
			return undefined;
		}
		const content = await this._readText(URI.parse(recordUriStr));
		if (content === undefined) {
			return undefined; // record could not be read
		}
		const diagrams = parseDimRecord(content);
		if (diagrams.length === 0) {
			return undefined;
		}
		return { sourceUri: ref.sourceUri, diagrams, recordActive: ref.recordActive };
	}

	/** Refreshes the breadcrumb picker's view options from the active editor. */
	private async _update(): Promise<void> {
		const seq = ++this._updateSeq;
		const activeEditor = this._editorService.activeEditor;
		const ref = this._ref(activeEditor);

		// Keep the viewer on the view its editor input names, and follow later changes.
		const viewInput = ref ? this._dimInput(activeEditor) : undefined;
		this._activeViewListener.value = viewInput?.onDidChangeSelection(() => this._syncViewer(viewInput));
		if (viewInput) {
			if (viewInput.view === undefined) {
				// Name the default view, so navigation history records it and going back
				// returns to it.
				viewInput.setView(README_VIEW_ID, EditorPaneSelectionChangeReason.NAVIGATION);
			}
			this._syncViewer(viewInput);
		}

		// The diagram viewer is the default editor for every code file, but only files Dim
		// supports (code files in the workspace, and big-picture records) have a record to
		// show. Any other file the viewer opened goes back to the text editor in place.
		if (!ref && activeEditor?.editorId === DIM_EDITOR_VIEW_TYPE && activeEditor.resource) {
			const group = this._editorGroupsService.activeGroup;
			await this._editorService.replaceEditors([{
				editor: activeEditor,
				replacement: { resource: activeEditor.resource.with({ fragment: '' }), options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: group.isPinned(activeEditor) } }
			}], group);
			return;
		}

		// Refresh the picker synchronously so the Raw and README views (always available
		// for a code file) show immediately, rather than waiting on the async record read
		// below that may add diagram views.
		this._onDidChangeViewOptions.fire();

		const context = await this._resolve(activeEditor);
		if (seq !== this._updateSeq) {
			return; // a newer update superseded this one
		}
		// Remember the diagrams a source file holds so the breadcrumb picker can list its
		// views synchronously later; drop the entry when the file no longer has a record.
		if (ref) {
			if (context && context.diagrams.length > 0) {
				this._diagramsBySource.set(ref.sourceUri.toString(), context.diagrams);
			} else {
				this._diagramsBySource.delete(ref.sourceUri.toString());
			}
		}
		this._onDidChangeViewOptions.fire();
	}

	/** The diagram viewer's editor input when the editor is one, else `undefined`. */
	private _dimInput(editor: EditorInput | null | undefined): CustomEditorInput | undefined {
		return editor instanceof CustomEditorInput && editor.viewType === DIM_EDITOR_VIEW_TYPE ? editor : undefined;
	}

	/**
	 * The view a diagram viewer shows: the one its input names when the record has it,
	 * otherwise the always-present README overview (which the viewer also falls back to).
	 */
	private _shownView(input: CustomEditorInput): string {
		const view = input.view;
		if (!view || view === README_VIEW_ID || !input.resource) {
			return README_VIEW_ID;
		}
		const diagrams = this._diagramsBySource.get(input.resource.toString());
		// Until the record has been read, trust the requested view: the viewer reads the
		// record itself and falls back when the view is missing.
		return !diagrams || diagrams.some(d => d.type === view) ? view : README_VIEW_ID;
	}

	/**
	 * Brings the picker and the diagram viewer in line with the view the viewer's input
	 * names. Dispatches synchronously, so rapid switches reach the viewer in order.
	 */
	private _syncViewer(input: CustomEditorInput): void {
		this._onDidChangeViewOptions.fire();
		if (input.resource) {
			void this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, input.resource.toString(), input.view ?? README_VIEW_ID);
		}
	}

	getViewOptions(editor: EditorInput): readonly IDimDiagramViewOption[] | undefined {
		const ref = this._ref(editor);
		if (!ref) {
			return undefined;
		}
		const diagrams = this._diagramsBySource.get(ref.sourceUri.toString()) ?? [];
		// The checked view is the one the diagram viewer shows, or Raw for the text editor.
		const viewInput = ref.recordActive ? this._dimInput(editor) : undefined;
		const current = viewInput ? this._shownView(viewInput) : ref.recordActive ? README_VIEW_ID : 'raw';
		// The README overview first (always available), then Raw (the editable source),
		// then one entry per diagram the record holds.
		const options: IDimDiagramViewOption[] = [
			{ id: README_VIEW_ID, label: readmeViewTitle(), commandId: README_COMMAND_ID, checked: current === README_VIEW_ID },
			{ id: 'raw', label: rawViewTitle(), commandId: RAW_COMMAND_ID, checked: current === 'raw' },
		];
		for (const type of dimDiagramTypeOrder) {
			if (diagrams.some(d => d.type === type)) {
				options.push({ id: type, label: dimViewTitle(type), commandId: diagramCommandId(type), checked: current === type });
			}
		}
		return options;
	}

	/** Switches the active editor slot back to the text editor, editable with full language support. */
	private async _showRaw(): Promise<void> {
		const group = this._editorGroupsService.activeGroup;
		const activeEditor = group.activeEditor;
		const ref = this._ref(activeEditor);
		if (!activeEditor || !ref || !ref.recordActive) {
			return; // the source file is already showing, or there is no record
		}
		// Reopen the same resource with the default (text) editor override: the diagram
		// viewer and text editor share one resource, so this reuses the tab in place. A
		// view focused on one symbol drops its focus fragment: the raw view is the file.
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: ref.sourceUri.with({ fragment: '' }), options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } }
		}], group);
	}

	/**
	 * Opens a source file, or one symbol of it, in the Dim diagram viewer: a new tab, or
	 * the existing one when that view is already open. Backs {@link OPEN_DIM_COMMAND},
	 * which a click in a diagram runs once it has resolved what was clicked.
	 *
	 * @param sourceUri The source file URI, with a focus fragment for one symbol.
	 * @param viewId The view to open on (a {@link DimDiagramType} or the README
	 * overview); the README overview when omitted.
	 */
	private async _openDim(sourceUri: URI, viewId: string | undefined): Promise<void> {
		if (this._isBigPicture(sourceUri) === undefined) {
			return; // not a file Dim has a record for
		}
		const view = viewId ?? README_VIEW_ID;
		// Tell the viewer which view to show before it opens, as {@link _showView} does,
		// so it resolves straight onto that view in its initial render.
		await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, sourceUri.toString(), view);
		await this._editorService.openEditor({ resource: sourceUri, options: { override: DIM_EDITOR_VIEW_TYPE, pinned: true, ...customEditorViewOptions(view) } });
	}

	/**
	 * Switches the active editor slot to the Dim diagram viewer, showing the given view
	 * (a {@link DimDiagramType} or the {@link README_VIEW_ID} overview).
	 */
	private async _showView(viewId: string): Promise<void> {
		const group = this._editorGroupsService.activeGroup;
		const activeEditor = group.activeEditor;
		const ref = this._ref(activeEditor);
		if (!activeEditor || !ref) {
			return;
		}
		const sourceKey = ref.sourceUri.toString();

		const viewInput = this._dimInput(activeEditor);
		if (viewInput) {
			// The diagram viewer is already showing: switch in place. The input records the
			// view (so going back returns to the previous one) and the change reaches the
			// picker and the viewer synchronously, so rapid clicks apply in order.
			viewInput.setView(viewId, EditorPaneSelectionChangeReason.NAVIGATION);
			return;
		}

		// The text editor is showing: tell the viewer which view to reveal *before*
		// opening it, so it resolves straight onto that view in its initial render.
		// Posting afterwards could race the webview's script loading and be dropped.
		await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, sourceKey, viewId);
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: ref.sourceUri, options: { override: DIM_EDITOR_VIEW_TYPE, pinned: true, ...customEditorViewOptions(viewId) } }
		}], group);
	}
}

// Eager so the service tracks the active editor from startup, before anything queries it
// for the breadcrumb picker's view options.
registerSingleton(IDimDiagramViewService, DimDiagramViewService, InstantiationType.Eager);

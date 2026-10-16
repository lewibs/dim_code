/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DimDiagramType, dimDiagramTypes } from '../../../../platform/agentHost/common/dimDiagramTypes.js';
import { DIM_EDITOR_VIEW_TYPE, IDimDiagram, isDimCodeFile, parseDimRecord, seedDimRecord } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IDimDiagramViewOption, IDimDiagramViewService } from '../../../services/dimDiagram/common/dimDiagramView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/**
 * Command run by the Dim diagram viewer to switch the currently shown diagram.
 * Registered by the `mermaid-markdown-features` extension; the Dim view toggle
 * calls it with the source file's URI and the diagram type to reveal.
 */
const SHOW_DIAGRAM_COMMAND = '_dim.showDiagram';

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
 * Drives Dim view switching. A source file opens as a normal, editable editor; the
 * Dim diagram viewer is a second editor (`option` priority) registered for the *same*
 * source resource, so both share one tab, path and breadcrumb — just like Markdown's
 * text/preview pair. This service reads the file's companion `.dim` record, registers
 * the commands that switch the same editor slot between the text editor and each
 * diagram, and exposes {@link getViewOptions} so the breadcrumb editor-type picker can
 * list the available views as a dropdown.
 */
class DimDiagramViewService extends Disposable implements IDimDiagramViewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeViewOptions = this._register(new Emitter<void>());
	readonly onDidChangeViewOptions: Event<void> = this._onDidChangeViewOptions.event;

	/**
	 * The view last selected for a source file (a {@link DimDiagramType} or
	 * {@link README_VIEW_ID}), so the picker can mark it active.
	 */
	private readonly _selectedBySource = new Map<string, string>();

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

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly _commandService: ICommandService,
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

		this._register(this._editorService.onDidActiveEditorChange(() => this._update()));
		this._update();
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
		const recordUri = await seedDimRecord(this._fileService, this._environmentService.workspaceStorageHome, folder.uri, sourceUri);
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
		Promise.resolve(this._commandService.executeCommand(GENERATE_RECORD_COMMAND, {
			scriptUri: DIM_GENERATOR_URI.toString(),
			sourceUri: sourceUri.toString(),
			recordUri: recordUri.toString(),
			relPath,
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
	private _ref(editor: EditorInput | null | undefined): { readonly sourceUri: URI; readonly recordActive: boolean } | undefined {
		const sourceUri = editor?.resource;
		if (!editor || !sourceUri || !isDimCodeFile(sourceUri) || !this._contextService.getWorkspaceFolder(sourceUri)) {
			return undefined;
		}
		return { sourceUri, recordActive: editor.editorId === DIM_EDITOR_VIEW_TYPE };
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
		const recordUriStr = await this._resolveRecordUri(ref.sourceUri.toString());
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

	getViewOptions(editor: EditorInput): readonly IDimDiagramViewOption[] | undefined {
		const ref = this._ref(editor);
		if (!ref) {
			return undefined;
		}
		const key = ref.sourceUri.toString();
		const diagrams = this._diagramsBySource.get(key) ?? [];
		// When the diagram viewer is showing, the default view mirrors the viewer's own:
		// the first diagram if the record has one, else the always-present README overview.
		const defaultView: string = diagrams.length > 0 ? diagrams[0].type : README_VIEW_ID;
		const current: string = ref.recordActive
			? (this._selectedBySource.get(key) ?? defaultView)
			: 'raw';
		// Raw first (the editable source), then the README overview (always available),
		// then one entry per diagram the record holds.
		const options: IDimDiagramViewOption[] = [
			{ id: 'raw', label: rawViewTitle(), commandId: RAW_COMMAND_ID, checked: current === 'raw' },
			{ id: README_VIEW_ID, label: readmeViewTitle(), commandId: README_COMMAND_ID, checked: current === README_VIEW_ID },
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
		// viewer and text editor share one resource, so this reuses the tab in place.
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: ref.sourceUri, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } }
		}], group);
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
		this._selectedBySource.set(sourceKey, viewId);

		if (ref.recordActive) {
			// The diagram viewer is already showing: switch in place. Refresh the picker's
			// checked view and dispatch synchronously (no `await` before the command) so rapid
			// clicks reach the viewer in click order and the last wins.
			this._onDidChangeViewOptions.fire();
			await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, sourceKey, viewId);
			return;
		}

		// The text editor is showing: tell the viewer which view to reveal *before*
		// opening it, so it resolves straight onto that view in its initial render.
		// Posting afterwards could race the webview's script loading and be dropped.
		await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, sourceKey, viewId);
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: ref.sourceUri, options: { override: DIM_EDITOR_VIEW_TYPE, pinned: true } }
		}], group);
	}
}

// Eager so the service tracks the active editor from startup, before anything queries it
// for the breadcrumb picker's view options.
registerSingleton(IDimDiagramViewService, DimDiagramViewService, InstantiationType.Eager);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { DimDiagramType, dimDiagramCatalog } from '../../../../platform/agentHost/common/dimDiagramTypes.js';
import { DIM_EDITOR_VIEW_TYPE, dimHookRecordUri, dimSourceFromRecordUri, IDimDiagram, isDimCodeFile, parseDimRecord, seedDimRecord } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/**
 * Command run by the `.dim` custom editor to switch the currently shown diagram.
 * Registered by the `mermaid-markdown-features` extension; the Dim view toggle
 * calls it with the record's URI and the diagram type to reveal.
 */
const SHOW_DIAGRAM_COMMAND = '_dim.showDiagram';

//#region Context keys

/** Whether the active editor has a `.dim` record with diagrams to toggle between. */
const DimViewActiveContext = new RawContextKey<boolean>('dimViewActive', false, { type: 'boolean', description: localize('dimViewActive', "Whether the active editor has a Dim diagram record") });

/** Which Dim view is currently shown for the active editor: `raw` or a diagram type. */
const DimActiveViewContext = new RawContextKey<string>('dimActiveView', '', { type: 'string', description: localize('dimActiveView', "The Dim view shown for the active editor (raw or a diagram type)") });

/** The context key id that flags whether the active record holds a diagram of a given type. */
function hasDiagramContextKeyId(type: DimDiagramType): string {
	return `dimHas.${type}`;
}

//#endregion

/** Codicon shown in the title-bar toggle for each diagram kind. */
const dimDiagramIcons: { readonly [type in DimDiagramType]: ThemeIcon } = {
	[DimDiagramType.Class]: Codicon.symbolClass,
	[DimDiagramType.Sequence]: Codicon.arrowSwap,
	[DimDiagramType.Flowchart]: Codicon.gitMerge,
	[DimDiagramType.State]: Codicon.typeHierarchy,
	[DimDiagramType.Entity]: Codicon.database,
	[DimDiagramType.Mindmap]: Codicon.listTree,
};

/** The diagram types in the order their buttons appear in the toggle. */
const dimDiagramTypeOrder = Object.keys(dimDiagramCatalog) as DimDiagramType[];

/** Localized title (and tooltip) for each diagram kind's toggle button. */
function dimViewTitle(type: DimDiagramType): string {
	switch (type) {
		case DimDiagramType.Class: return localize('dim.view.structure', "Structure");
		case DimDiagramType.Sequence: return localize('dim.view.behavior', "Behavior");
		case DimDiagramType.Flowchart: return localize('dim.view.logic', "Logic");
		case DimDiagramType.State: return localize('dim.view.states', "States");
		case DimDiagramType.Entity: return localize('dim.view.data', "Data");
		case DimDiagramType.Mindmap: return localize('dim.view.overview', "Overview");
	}
}

/** The command id that switches the active editor to a given diagram view. */
function diagramCommandId(type: DimDiagramType): string {
	return `dim.view.${type}`;
}

/** The command id that switches the active editor to the raw, editable source file. */
const RAW_COMMAND_ID = 'dim.view.raw';

/**
 * The Dim context resolved for an editor: the `.dim` record it relates to, the
 * diagrams the record holds, and whether the editor currently showing is the record
 * (a diagram) rather than the source file.
 */
interface IDimEditorContext {
	readonly recordUri: URI;
	readonly diagrams: readonly IDimDiagram[];
	readonly recordActive: boolean;
}

/**
 * Drives the Dim view toggle in the editor title bar. A source file opens as a
 * normal, editable editor; this contribution detects the file's companion `.dim`
 * record, publishes context keys describing which diagrams it holds and which view
 * is shown, and registers the commands the toggle buttons run to switch — in the
 * same editor slot — between the raw file and each diagram.
 */
class DimEditorViewToggle extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dimEditorViewToggle';

	private readonly _viewActive: IContextKey<boolean>;
	private readonly _activeView: IContextKey<string>;
	private readonly _hasDiagram = new Map<DimDiagramType, IContextKey<boolean>>();

	/** The diagram last selected for a record, so the toggle can mark it active. */
	private readonly _selectedByRecord = new Map<string, DimDiagramType>();

	/**
	 * The last resolved context per active-editor resource, so revisiting a file paints
	 * the toggle synchronously without waiting for the record read; refreshed on every
	 * activation so a changed record self-heals.
	 */
	private readonly _contextCache = new Map<string, IDimEditorContext | undefined>();

	/** Guards against out-of-order async updates when the active editor changes quickly. */
	private _updateSeq = 0;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		this._viewActive = DimViewActiveContext.bindTo(contextKeyService);
		this._activeView = DimActiveViewContext.bindTo(contextKeyService);
		for (const type of dimDiagramTypeOrder) {
			this._hasDiagram.set(type, new RawContextKey<boolean>(hasDiagramContextKeyId(type), false).bindTo(contextKeyService));
		}

		for (const type of dimDiagramTypeOrder) {
			this._register(CommandsRegistry.registerCommand(diagramCommandId(type), () => this._showDiagram(type)));
		}
		this._register(CommandsRegistry.registerCommand(RAW_COMMAND_ID, () => this._showRaw()));

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

	/** The open workspace folders' URIs, for mapping a record back to its source file. */
	private _workspaceFolderUris(): URI[] {
		return this._contextService.getWorkspace().folders.map(folder => folder.uri);
	}

	/**
	 * Resolves the Dim context for a resource, whether it is a source file (raw view)
	 * or a `.dim` record (diagram view). Returns `undefined` when the resource has no
	 * Dim record with diagrams, so the toggle stays hidden (e.g. non-code files).
	 */
	private async _resolve(resource: URI | undefined): Promise<IDimEditorContext | undefined> {
		const ref = this._recordRef(resource);
		if (!ref) {
			return undefined;
		}

		// A source file still needs its record seeded (a placeholder when neither the
		// hook nor an earlier open wrote one) so the toggle also appears for editors
		// restored on window load, not only for files opened during the session.
		if (!ref.recordActive) {
			const folder = resource && this._contextService.getWorkspaceFolder(resource);
			if (!folder || !(await seedDimRecord(this._fileService, this._environmentService.workspaceStorageHome, folder.uri, resource))) {
				return undefined;
			}
		}

		const content = await this._readText(ref.recordUri);
		if (content === undefined) {
			return undefined; // record could not be read
		}
		const diagrams = parseDimRecord(content);
		if (diagrams.length === 0) {
			return undefined;
		}
		return { recordUri: ref.recordUri, diagrams, recordActive: ref.recordActive };
	}

	/**
	 * Resolves, synchronously and without any file I/O, which `.dim` record a resource
	 * relates to and whether that record (a diagram) — rather than the source file — is
	 * what the editor currently shows. Returns `undefined` for resources that get no
	 * record (non-code files, or files outside the workspace).
	 *
	 * This is the switch actions' fast path: choosing a diagram must not wait on an async
	 * read that could reorder against a rapid second click and leave the wrong diagram
	 * showing. Diagram contents (for the context keys) still come from {@link _resolve}.
	 */
	private _recordRef(resource: URI | undefined): { readonly recordUri: URI; readonly recordActive: boolean } | undefined {
		if (!resource) {
			return undefined;
		}
		const storageHome = this._environmentService.workspaceStorageHome;

		// A `.dim` record under the storage root: a diagram view is showing.
		if (resource.path.endsWith('.dim') && this._uriIdentityService.extUri.isEqualOrParent(resource, storageHome)) {
			return { recordUri: resource, recordActive: true };
		}

		// A source file: the raw view is showing. Map it to its (possibly not-yet-seeded) record.
		if (!isDimCodeFile(resource)) {
			return undefined;
		}
		const folder = this._contextService.getWorkspaceFolder(resource);
		if (!folder) {
			return undefined;
		}
		const recordUri = dimHookRecordUri(storageHome, folder.uri, resource);
		return recordUri ? { recordUri, recordActive: false } : undefined;
	}

	/** Recomputes the toggle's context keys from the active editor. */
	private async _update(): Promise<void> {
		const seq = ++this._updateSeq;
		const resource = this._editorService.activeEditor?.resource;
		const key = resource?.toString();

		// Paint from the cache synchronously so the toggle appears immediately when a
		// file is revisited; the async resolve below refreshes it (and covers first visits).
		if (key !== undefined && this._contextCache.has(key)) {
			this._applyContext(this._contextCache.get(key));
		}

		const context = await this._resolve(resource);
		if (seq !== this._updateSeq) {
			return; // a newer update superseded this one
		}
		if (key !== undefined) {
			this._contextCache.set(key, context);
		}
		this._applyContext(context);
	}

	/** Publishes the toggle's context keys for a resolved context, or hides it when none. */
	private _applyContext(context: IDimEditorContext | undefined): void {
		if (!context) {
			this._viewActive.set(false);
			this._activeView.set('');
			for (const key of this._hasDiagram.values()) {
				key.set(false);
			}
			return;
		}

		this._viewActive.set(true);
		for (const type of dimDiagramTypeOrder) {
			this._hasDiagram.get(type)!.set(context.diagrams.some(d => d.type === type));
		}
		const activeView = context.recordActive
			? (this._selectedByRecord.get(context.recordUri.toString()) ?? context.diagrams[0].type)
			: 'raw';
		this._activeView.set(activeView);
	}

	/** Switches the active editor slot to the source file, editable with full language support. */
	private async _showRaw(): Promise<void> {
		const group = this._editorGroupsService.activeGroup;
		const activeEditor = group.activeEditor;
		const ref = this._recordRef(activeEditor?.resource);
		if (!activeEditor || !ref || !ref.recordActive) {
			return; // the source file is already showing, or there is no record
		}
		const sourceUri = dimSourceFromRecordUri(this._environmentService.workspaceStorageHome, this._workspaceFolderUris(), ref.recordUri);
		if (!sourceUri) {
			return;
		}
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: sourceUri, options: { pinned: true } }
		}], group);
	}

	/** Switches the active editor slot to the `.dim` diagram view for the given type. */
	private async _showDiagram(type: DimDiagramType): Promise<void> {
		const group = this._editorGroupsService.activeGroup;
		const activeEditor = group.activeEditor;
		const ref = this._recordRef(activeEditor?.resource);
		if (!activeEditor || !ref) {
			return;
		}
		const recordKey = ref.recordUri.toString();
		this._selectedByRecord.set(recordKey, type);

		if (ref.recordActive) {
			// The diagram viewer is already showing: switch in place. Reflect the choice in
			// the toggle immediately and dispatch synchronously (no `await` before the
			// command) so rapid clicks reach the viewer in click order and the last wins.
			this._activeView.set(type);
			await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, recordKey, type);
			return;
		}

		// The raw file is showing: tell the viewer which diagram to reveal *before* opening
		// it, so the (not-yet-open) record resolves straight onto that diagram in its initial
		// render. Posting afterwards could race the webview's script loading and be dropped.
		await this._commandService.executeCommand(SHOW_DIAGRAM_COMMAND, recordKey, type);
		await this._editorService.replaceEditors([{
			editor: activeEditor,
			replacement: { resource: ref.recordUri, options: { override: DIM_EDITOR_VIEW_TYPE, pinned: true } }
		}], group);
	}
}

registerWorkbenchContribution2(DimEditorViewToggle.ID, DimEditorViewToggle, WorkbenchPhase.AfterRestored);

//#region Editor title bar toggle

// A diagram button per kind, shown only when the active editor's record holds that
// kind. `toggled` highlights the one currently shown, so the group reads as a radio.
dimDiagramTypeOrder.forEach((type, index) => {
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: {
			id: diagramCommandId(type),
			title: dimViewTitle(type),
			icon: dimDiagramIcons[type],
			toggled: ContextKeyExpr.equals(DimActiveViewContext.key, type)
		},
		group: 'navigation',
		order: index + 1,
		when: ContextKeyExpr.and(DimViewActiveContext.isEqualTo(true), ContextKeyExpr.has(hasDiagramContextKeyId(type)))
	});
});

// The "Raw" button shows the real, editable source file. Present whenever there is
// a record to toggle away from.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: RAW_COMMAND_ID,
		title: localize('dim.view.raw', "Raw"),
		icon: Codicon.code,
		toggled: ContextKeyExpr.equals(DimActiveViewContext.key, 'raw')
	},
	group: 'navigation',
	order: 100,
	when: DimViewActiveContext.isEqualTo(true)
});

//#endregion

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dimPendingEdits.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { constObservable, IObservable, observableValue } from '../../../../base/common/observable.js';
import { isEqual, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { IDocumentDiff, nullDocumentDiff } from '../../../../editor/common/diff/documentDiffProvider.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPane } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ChatEditingCodeEditorIntegration, IDocumentDiff2 } from '../../chat/browser/chatEditing/chatEditingCodeEditorIntegration.js';
import { IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ModifiedFileEntryState } from '../../chat/common/editing/chatEditingService.js';

/**
 * The git commands of the review, run in the extension host (it can spawn git). Duplicated in
 * `extensions/mermaid-markdown-features/src/dimReview.ts`; keep the two in sync.
 */
const REVIEW_LIST_COMMAND = '_dim.review.list';
const REVIEW_READ_STAGED_COMMAND = '_dim.review.readStaged';
const REVIEW_STAGE_ALL_COMMAND = '_dim.review.stageAll';

/** A file with changes waiting for review, as {@link REVIEW_LIST_COMMAND} reports it. */
interface IDimReviewFile {
	/** Relative to the workspace folder. */
	readonly path: string;
	/** The staged blob the changes are measured against, or {@link NEW_FILE_STAMP}. */
	readonly stamp: string;
}

/** The stamp of a file git does not track yet: all of it waits for review. */
const NEW_FILE_STAMP = 'new';

/** Whether the active editor shows a file with changes waiting for review (in Raw or a Dim view). */
const DIM_ACTIVE_EDITOR_HAS_PENDING_EDITS = new RawContextKey<boolean>('dimActiveEditorHasPendingEdits', false, localize('dimActiveEditorHasPendingEdits', "Whether the active editor shows a file with changes waiting for review"));

/** Whether anything in the workspace waits for review. */
const DIM_HAS_PENDING_EDITS = new RawContextKey<boolean>('dimHasPendingEdits', false, localize('dimHasPendingEdits', "Whether the workspace has changes waiting for review"));

/** How far the review bar floats above the bottom of a text editor. */
const REVIEW_BAR_MARGIN = 16;

/** The URI scheme of the in-memory models that hold a file's accepted text. */
const DIM_PENDING_SCHEME = 'dim-pending';

/** How long a burst of file changes settles before the changed files are listed again. */
const RESCAN_DELAY = 300;

/** How long typing settles before a file's diff against its accepted text is recomputed. */
const DIFF_DELAY = 200;

export const IDimPendingEditsService = createDecorator<IDimPendingEditsService>('dimPendingEditsService');

/**
 * Tracks the changes waiting for review. Every change not staged in git waits, whoever made
 * it (the agent or the user). Review is all or nothing: accepting stages every change in the
 * workspace, so a file's staged version is what the user has accepted, and rejecting puts
 * the staged text back into a file.
 */
export interface IDimPendingEditsService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires with a file whose changes waiting for review changed: it gained or lost them
	 * (they were accepted or rejected), or the file changed on disk while it has them.
	 */
	readonly onDidChange: Event<URI>;

	/** Whether the file has changes waiting for review. */
	hasPendingEdits(file: URI): boolean;

	/** The file's accepted (staged) text; empty for a file git does not track yet. */
	readAccepted(file: URI): Promise<string>;

	/** Accepts every change waiting for review in the workspace: stages all of it. */
	acceptAll(): Promise<void>;

	/**
	 * Rejects all of a file's changes: puts the accepted text back into the file (undoably),
	 * or deletes the file when git does not track it yet.
	 */
	rejectAll(file: URI): Promise<void>;
}

class DimPendingEditsService extends Disposable implements IDimPendingEditsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;

	/** Each file with changes waiting for review, mapped to its stamp (see {@link IDimReviewFile}). */
	private _stamps = new ResourceMap<string>();

	private readonly _rescan = this._register(new RunOnceScheduler(() => void this._queueScan(), RESCAN_DELAY));
	private _scanning: Promise<void> = Promise.resolve();

	private readonly _activeHasPendingEdits: IContextKey<boolean>;
	private readonly _hasPendingEdits: IContextKey<boolean>;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._activeHasPendingEdits = DIM_ACTIVE_EDITOR_HAS_PENDING_EDITS.bindTo(contextKeyService);
		this._hasPendingEdits = DIM_HAS_PENDING_EDITS.bindTo(contextKeyService);

		// Any change in the workspace (a saved file, a new one, git's index) may change what
		// waits for review; listing it again is one quick git run.
		this._register(this._fileService.onDidFilesChange(e => {
			for (const file of this._stamps.keys()) {
				if (e.contains(file)) {
					this._onDidChange.fire(file);
				}
			}
			this._rescan.schedule();
		}));
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this._rescan.schedule()));
		this._register(this._editorService.onDidActiveEditorChange(() => this._updateContext()));
		this._register(this.onDidChange(() => this._updateContext()));
		this._rescan.schedule();
	}

	hasPendingEdits(file: URI): boolean {
		return this._stamps.has(file.with({ fragment: '' }));
	}

	async readAccepted(file: URI): Promise<string> {
		return await this._commandService.executeCommand<string>(REVIEW_READ_STAGED_COMMAND, file.toString()) ?? '';
	}

	async acceptAll(): Promise<void> {
		// Save first: git stages the files on disk.
		await this._editorService.saveAll();
		for (const folder of this._contextService.getWorkspace().folders) {
			await this._commandService.executeCommand(REVIEW_STAGE_ALL_COMMAND, folder.uri.toString());
		}
		await this._queueScan();
	}

	async rejectAll(file: URI): Promise<void> {
		const stamp = this._stamps.get(file.with({ fragment: '' }));
		if (stamp === undefined) {
			return;
		}
		if (stamp === NEW_FILE_STAMP) {
			if (await this._fileService.exists(file)) {
				await this._fileService.del(file, { useTrash: true });
			}
		} else {
			const text = await this.readAccepted(file);
			const ref = await this._textModelService.createModelReference(file);
			try {
				const model = ref.object.textEditorModel;
				// An edit rather than `setValue`, so the user can undo the rejection.
				model.pushStackElement();
				model.pushEditOperations(null, [EditOperation.replace(model.getFullModelRange(), text)], () => null);
				model.pushStackElement();
				await this._textFileService.save(file);
			} finally {
				ref.dispose();
			}
		}
		await this._queueScan();
	}

	/** Lists the changed files again once any scan in flight is done, so scans never overlap. */
	private _queueScan(): Promise<void> {
		this._scanning = this._scanning.then(() => this._scan(), () => this._scan());
		return this._scanning;
	}

	/** Lists the workspace folders' changed files, and reports each file whose stamp changed. */
	private async _scan(): Promise<void> {
		const stamps = new ResourceMap<string>();
		for (const folder of this._contextService.getWorkspace().folders) {
			const files = await this._commandService.executeCommand<IDimReviewFile[] | undefined>(REVIEW_LIST_COMMAND, folder.uri.toString());
			for (const file of files ?? []) {
				stamps.set(joinPath(folder.uri, file.path), file.stamp);
			}
		}
		const changed: URI[] = [];
		for (const [file, stamp] of stamps) {
			if (this._stamps.get(file) !== stamp) {
				changed.push(file);
			}
		}
		for (const file of this._stamps.keys()) {
			if (!stamps.has(file)) {
				changed.push(file);
			}
		}
		this._stamps = stamps;
		this._hasPendingEdits.set(stamps.size > 0);
		for (const file of changed) {
			this._onDidChange.fire(file);
		}
	}

	private _updateContext(): void {
		const resource = this._editorService.activeEditor?.resource;
		this._activeHasPendingEdits.set(!!resource && this.hasPendingEdits(resource));
	}
}

registerSingleton(IDimPendingEditsService, DimPendingEditsService, InstantiationType.Eager);

/**
 * One file's changes waiting for review, as a diff between its accepted text (held in an
 * in-memory model) and its current text, in the shape the chat editing integration works
 * with. Changes are reviewed all or nothing, so keeping or undoing any change accepts or
 * rejects the whole file.
 */
class DimPendingDiff extends Disposable {

	private static _ids = 0;

	private readonly _diff = observableValue<IDocumentDiff>(this, nullDocumentDiff);
	private readonly _recompute = this._register(new RunOnceScheduler(() => this._computeDiff(), DIFF_DELAY));

	private _original: ITextModel | undefined;
	private _modified: ITextModel | undefined;
	private _diffInfo: IObservable<IDocumentDiff2> | undefined;

	/** Resolves once both models are loaded and the first diff is computed. */
	readonly ready: Promise<void>;

	constructor(
		private readonly _file: URI,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IDimPendingEditsService private readonly _pendingEditsService: IDimPendingEditsService,
	) {
		super();
		this.ready = this._load();
	}

	/** The diff with its models, for the chat editing integration; only available once {@link ready}. */
	get diffInfo(): IObservable<IDocumentDiff2> {
		if (!this._diffInfo) {
			throw new Error('DimPendingDiff is not ready');
		}
		return this._diffInfo;
	}

	/** The URI of the model holding the accepted text. */
	get originalUri(): URI | undefined {
		return this._original?.uri;
	}

	private async _load(): Promise<void> {
		const ref = await this._textModelService.createModelReference(this._file);
		if (this._store.isDisposed) {
			ref.dispose();
			return;
		}
		this._register(ref);
		const accepted = await this._pendingEditsService.readAccepted(this._file);
		if (this._store.isDisposed) {
			return;
		}
		const modified = this._modified = ref.object.textEditorModel;
		const original = this._original = this._register(this._modelService.createModel(
			accepted,
			this._languageService.createById(modified.getLanguageId()),
			URI.from({ scheme: DIM_PENDING_SCHEME, path: this._file.path, query: String(DimPendingDiff._ids++) }),
			false
		));
		this._diffInfo = this._diff.map(diff => ({
			...diff,
			originalModel: original,
			modifiedModel: modified,
			keep: async () => {
				await this._pendingEditsService.acceptAll();
				return true;
			},
			undo: async () => {
				await this._pendingEditsService.rejectAll(this._file);
				return true;
			},
		}) satisfies IDocumentDiff2);

		this._register(modified.onDidChangeContent(() => this._recompute.schedule()));
		// The accepted text moves when changes are accepted elsewhere: in another editor,
		// in the Source Control view, or with git itself.
		this._register(this._pendingEditsService.onDidChange(file => {
			if (isEqual(file, this._file)) {
				void this._reloadAccepted();
			}
		}));
		await this._computeDiff();
	}

	private async _reloadAccepted(): Promise<void> {
		const accepted = await this._pendingEditsService.readAccepted(this._file);
		if (this._original && !this._original.isDisposed() && accepted !== this._original.getValue()) {
			this._original.setValue(accepted);
			await this._computeDiff();
		}
	}

	private async _computeDiff(): Promise<void> {
		const original = this._original;
		const modified = this._modified;
		if (!original || !modified || original.isDisposed() || modified.isDisposed()) {
			return;
		}
		const originalVersion = original.getVersionId();
		const modifiedVersion = modified.getVersionId();
		const diff = await this._editorWorkerService.computeDiff(original.uri, modified.uri, {
			ignoreTrimWhitespace: false, // show every change that accepting would stage
			computeMoves: false,
			maxComputationTimeMs: 3000
		}, 'advanced');
		// Only when neither model changed in the meantime.
		if (!this._store.isDisposed && original.getVersionId() === originalVersion && modified.getVersionId() === modifiedVersion) {
			this._diff.set(diff ?? nullDocumentDiff, undefined);
		}
	}
}

/**
 * The bar that floats at the bottom of a text editor whose file has changes waiting for
 * review, with Accept All and Reject All. Mirrors the review bar of the Dim diagram viewer
 * (`extensions/mermaid-markdown-features/src/editorManager.ts`), so every view of a file
 * reviews it the same way.
 */
class DimReviewBarWidget extends Disposable implements IOverlayWidget {

	private static readonly ID = 'editor.widget.dimReviewBar';

	private readonly _domNode = $('.dim-review-bar');
	private _position: IOverlayWidgetPosition | null = null;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _file: URI,
		@IDimPendingEditsService private readonly _pendingEditsService: IDimPendingEditsService,
	) {
		super();
		this._domNode.setAttribute('role', 'toolbar');
		this._domNode.setAttribute('aria-label', localize('dimReviewBar', "Changes Waiting for Review"));
		append(this._domNode, $('span.dim-review-bar-title')).textContent = localize('dimReviewBarTitle', "Changes waiting for review");

		const accept = this._register(new Button(this._domNode, { ...defaultButtonStyles, supportIcons: true, title: localize('dimReviewBarAcceptTitle', "Accept All Changes in the Workspace") }));
		accept.label = `$(${Codicon.check.id}) ${localize('dimReviewBarAccept', "Accept All")}`;
		const reject = this._register(new Button(this._domNode, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('dimReviewBarRejectTitle', "Reject All Changes in File") }));
		reject.label = `$(${Codicon.discard.id}) ${localize('dimReviewBarReject', "Reject All")}`;

		// Both stay disabled from a click until the review finishes, so a double click
		// cannot accept or reject twice.
		const run = async (action: () => Promise<void>) => {
			accept.enabled = reject.enabled = false;
			try {
				await action();
			} finally {
				accept.enabled = reject.enabled = true;
			}
		};
		this._register(accept.onDidClick(() => run(() => this._pendingEditsService.acceptAll())));
		this._register(reject.onDidClick(() => run(() => this._pendingEditsService.rejectAll(this._file))));

		this._editor.addOverlayWidget(this);
		this._register(this._editor.onDidLayoutChange(() => this._layout()));
		this._layout();
	}

	getId(): string {
		return DimReviewBarWidget.ID;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	/** Centers the bar horizontally over the text, just above the bottom of the editor. */
	private _layout(): void {
		const layoutInfo = this._editor.getLayoutInfo();
		const textWidth = layoutInfo.width - layoutInfo.verticalScrollbarWidth;
		this._position = {
			preference: {
				top: Math.max(0, layoutInfo.height - layoutInfo.horizontalScrollbarHeight - this._domNode.offsetHeight - REVIEW_BAR_MARGIN),
				left: Math.max(0, (textWidth - this._domNode.offsetWidth) / 2),
			}
		};
		this._editor.layoutOverlayWidget(this);
	}

	override dispose(): void {
		this._editor.removeOverlayWidget(this);
		super.dispose();
	}
}

/**
 * Shows a file's changes waiting for review in its text editor: removed lines in view zones, added ones
 * highlighted, as for chat edits, and the review bar at the bottom. Changes are reviewed all or nothing,
 * so there are no accept or reject buttons on the changes themselves.
 */
class DimPendingEditsEditorContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.dimPendingEdits';

	private readonly _session = this._register(new MutableDisposable<DisposableStore>());
	private _sessionKey: string | undefined;
	private _integration: IModifiedFileEntryEditorIntegration | undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		@IDimPendingEditsService private readonly _pendingEditsService: IDimPendingEditsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register(this._editor.onDidChangeModel(() => this._update()));
		this._register(this._pendingEditsService.onDidChange(file => {
			if (isEqual(file, this._editor.getModel()?.uri)) {
				this._update();
			}
		}));
		this._update();
	}

	private _update(): void {
		const file = this._editor.getModel()?.uri;
		const pending = !!file && !this._editor.getOption(EditorOption.inDiffEditor) && this._pendingEditsService.hasPendingEdits(file);
		const key = file && pending ? file.toString() : undefined;
		if (key === this._sessionKey) {
			return;
		}
		this._sessionKey = key;
		this._integration = undefined;
		this._session.clear();
		if (!file || !pending) {
			return;
		}

		const store = this._session.value = new DisposableStore();
		store.add(this._instantiationService.createInstance(DimReviewBarWidget, this._editor, file));
		const diff = store.add(this._instantiationService.createInstance(DimPendingDiff, file));
		void diff.ready.then(() => {
			if (store.isDisposed) {
				return;
			}
			const entry = this._entry(file, diff);
			this._integration = store.add(this._instantiationService.createInstance(ChatEditingCodeEditorIntegration, entry, this._editor, diff.diffInfo, true, false));
		});
	}

	/** The changes waiting for review in the shape of a chat editing entry, which the chat editing integration reports to. */
	private _entry(file: URI, diff: DimPendingDiff): IModifiedFileEntry {
		const service = this._pendingEditsService;
		const diffInfo = diff.diffInfo;
		return {
			entryId: `${DIM_PENDING_SCHEME}:${file.toString()}`,
			originalURI: diff.originalUri ?? file,
			modifiedURI: file,
			lastModifyingRequestId: '',
			state: constObservable(ModifiedFileEntryState.Modified),
			isCurrentlyBeingModifiedBy: constObservable(undefined),
			lastModifyingResponse: constObservable(undefined),
			rewriteRatio: constObservable(0),
			waitsForLastEdits: constObservable(false),
			accept: () => service.acceptAll(),
			reject: () => service.rejectAll(file),
			reviewMode: constObservable(true),
			autoAcceptController: constObservable(undefined),
			enableReviewModeUntilSettled: () => { },
			changesCount: diffInfo.map(info => info.changes.length),
			diffInfo,
			getEditorIntegration: (_pane: IEditorPane) => {
				if (!this._integration) {
					throw new Error('Dim changes waiting for review are not shown');
				}
				return this._integration;
			},
		};
	}
}

registerEditorContribution(DimPendingEditsEditorContribution.ID, DimPendingEditsEditorContribution, EditorContributionInstantiation.AfterFirstRender);

const dimCategory = localize2('dimCategory', "Dim");

/**
 * Accepts every change waiting for review in the workspace, all or nothing: there is no
 * accepting one file's or one change's alone.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dim.pendingEdits.acceptAll',
			title: localize2('dimAcceptAll', "Accept All Changes"),
			shortTitle: localize2('dimAcceptAllShort', "Accept All"),
			category: dimCategory,
			icon: Codicon.check,
			precondition: DIM_HAS_PENDING_EDITS,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IDimPendingEditsService).acceptAll();
	}
});

/** Rejects all of a file's changes waiting for review: the given one, or the active editor's. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dim.pendingEdits.rejectAll',
			title: localize2('dimRejectAll', "Reject All Changes in File"),
			shortTitle: localize2('dimRejectAllShort', "Reject All"),
			category: dimCategory,
			icon: Codicon.discard,
			precondition: DIM_ACTIVE_EDITOR_HAS_PENDING_EDITS,
			f1: true,
		});
	}

	/** @param resource The file (from the diagram viewer), or nothing for the active editor's. */
	override async run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		const file = URI.isUri(resource) ? resource : accessor.get(IEditorService).activeEditor?.resource;
		if (file) {
			await accessor.get(IDimPendingEditsService).rejectAll(file);
		}
	}
});

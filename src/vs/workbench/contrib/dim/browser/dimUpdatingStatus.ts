/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { dimHookStorageDir } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * The folder, inside a workspace's records folder, where each running Dim Stop hook keeps a
 * status file named by its process id: the first line is the number of files it checks and
 * each finished file appends a line. Written by `updateDimHook.sh` and, for the changes
 * diagram, `generateDimChanges.sh`; keep the three in sync.
 */
const UPDATING_FOLDER_NAME = '.updating';

/**
 * How long a run must last before the status bar entry shows. Most Stop hooks find every
 * record up to date within a moment, and the entry should not flash for those.
 */
const SHOW_DELAY = 500;

/** How long a burst of status file changes settles before they are read again. */
const RESCAN_DELAY = 100;

/**
 * A status file untouched for this long belongs to a run that was killed (each finished
 * file touches it, and one file takes Claude a few minutes at most), so it is ignored.
 */
const STALE_AFTER = 30 * 60 * 1000;

/** How far a run of the Dim Stop hook has got, summed over every run in progress. */
interface IDimUpdateProgress {
	readonly done: number;
	readonly total: number;
}

/**
 * Shows "Updating diagrams" in the status bar while the Dim Stop hook regenerates the
 * diagrams of the files an agent changed, so the user can see the work happening in the
 * background (it otherwise runs detached and silent).
 */
class DimUpdatingStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dimUpdatingStatus';

	private readonly _watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _rescan = this._register(new RunOnceScheduler(() => this._scan(), RESCAN_DELAY));
	private readonly _show = this._register(new RunOnceScheduler(() => this._showEntry(), SHOW_DELAY));
	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _progress: IDimUpdateProgress = { done: 0, total: 0 };

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();

		this._register(this._contextService.onDidChangeWorkspaceFolders(e => {
			for (const folder of e.removed) {
				this._watchers.deleteAndDispose(folder.uri.toString());
			}
			for (const folder of e.added) {
				this._watch(folder.uri);
			}
			this._rescan.schedule();
		}));
		for (const folder of this._contextService.getWorkspace().folders) {
			this._watch(folder.uri);
		}
		this._rescan.schedule();
	}

	/** Watches a workspace folder's status folder, which need not exist yet. */
	private _watch(folder: URI): void {
		const store = new DisposableStore();
		this._watchers.set(folder.toString(), store);
		const statusFolder = this._statusFolder(folder);
		const watcher = store.add(this._fileService.createWatcher(statusFolder, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => this._rescan.schedule()));
	}

	private _statusFolder(folder: URI): URI {
		return joinPath(dimHookStorageDir(folder), UPDATING_FOLDER_NAME);
	}

	/** Reads every running hook's status file and updates the entry to match. */
	private async _scan(): Promise<void> {
		let done = 0;
		let total = 0;
		const now = Date.now();
		for (const folder of this._contextService.getWorkspace().folders) {
			const progress = await this._readFolder(this._statusFolder(folder.uri), now);
			done += progress.done;
			total += progress.total;
		}
		this._update({ done, total });
	}

	private async _readFolder(statusFolder: URI, now: number): Promise<IDimUpdateProgress> {
		let done = 0;
		let total = 0;
		try {
			const stat = await this._fileService.resolve(statusFolder, { resolveMetadata: true });
			for (const child of stat.children ?? []) {
				if (child.isDirectory || now - child.mtime > STALE_AFTER) {
					continue;
				}
				// "<total>\n" then one "\n" per finished file, so it splits into total + done + 1 parts.
				const lines = (await this._fileService.readFile(child.resource)).value.toString().split('\n');
				total += parseInt(lines[0], 10) || 0;
				done += Math.max(lines.length - 2, 0);
			}
		} catch {
			// No status folder (nothing has run yet) or a run just finished and removed its file.
		}
		return { done, total };
	}

	private _update(progress: IDimUpdateProgress): void {
		this._progress = progress;
		if (progress.total === 0) {
			this._show.cancel();
			this._entry.clear();
			return;
		}
		if (this._entry.value) {
			this._entry.value.update(this._entryProps());
		} else if (!this._show.isScheduled()) {
			this._show.schedule();
		}
	}

	private _showEntry(): void {
		this._entry.value = this._statusbarService.addEntry(this._entryProps(), DimUpdatingStatusContribution.ID, StatusbarAlignment.LEFT, -Number.MAX_VALUE);
	}

	private _entryProps(): IStatusbarEntry {
		const label = localize('dimUpdatingDiagrams', "Updating diagrams {0}/{1}", this._progress.done, this._progress.total);
		return {
			name: localize('dimUpdatingDiagramsName', "Dim Diagram Updates"),
			text: `$(loading~spin) ${label}`,
			ariaLabel: label,
			tooltip: localize('dimUpdatingDiagramsTooltip', "Dim is redrawing the diagrams of the files the agent changed."),
		};
	}
}

registerWorkbenchContribution2(DimUpdatingStatusContribution.ID, DimUpdatingStatusContribution, WorkbenchPhase.AfterRestored);

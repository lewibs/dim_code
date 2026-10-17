/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dimUpdatingPill.css';
import { $, append } from '../../../../base/browser/dom.js';
import { getOrCreateAnchorName } from '../../../../base/browser/overlayLayoutElement.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { dimHookStorageDir } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

/**
 * The folder, inside a workspace's records folder, where each running Dim Stop hook keeps a
 * status file named by its process id: the first line is the number of files it checks and
 * each finished file appends a line. Written by `updateDimHook.sh` and, for the changes
 * diagram, `generateDimChanges.sh`; keep the three in sync.
 */
const UPDATING_FOLDER_NAME = '.updating';

/**
 * How long a run must last before the pill shows. Most Stop hooks find every record up to
 * date within a moment, and the pill should not flash for those.
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
 * Floats an "Updating diagrams" pill at the top right of the editor area while the Dim
 * Stop hook regenerates the diagrams of the files an agent changed, so the user can see
 * the work happening in the background (it otherwise runs detached and silent).
 */
class DimUpdatingPillContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dimUpdatingPill';

	private readonly _watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _rescan = this._register(new RunOnceScheduler(() => this._scan(), RESCAN_DELAY));
	private readonly _show = this._register(new RunOnceScheduler(() => this._setVisible(true), SHOW_DELAY));
	private readonly _pill: HTMLElement;
	private readonly _label: HTMLElement;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super();

		this._pill = $('.dim-updating-pill');
		this._pill.setAttribute('role', 'status');
		append(this._pill, $(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
		this._label = append(this._pill, $('span.dim-updating-pill-label'));
		// Diagrams are webviews, which float in their own layer above the editor area (see
		// OverlayLayoutElement). Mount the pill in that same top-level container, above them,
		// and pin it to the editor area with CSS anchor positioning.
		this._layoutService.getContainer(mainWindow).appendChild(this._pill);
		this._register({ dispose: () => this._pill.remove() });

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

	/** Reads every running hook's status file and updates the pill to match. */
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
		if (progress.total === 0) {
			this._show.cancel();
			this._setVisible(false);
			return;
		}
		this._label.textContent = localize('dimUpdatingDiagrams', "Updating diagrams {0}/{1}", progress.done, progress.total);
		if (!this._pill.classList.contains('visible') && !this._show.isScheduled()) {
			this._show.schedule();
		}
	}

	private _setVisible(visible: boolean): void {
		if (visible) {
			const editorPart = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
			if (editorPart) {
				this._pill.style.setProperty('position-anchor', getOrCreateAnchorName(editorPart));
			}
		}
		this._pill.classList.toggle('visible', visible);
	}
}

registerWorkbenchContribution2(DimUpdatingPillContribution.ID, DimUpdatingPillContribution, WorkbenchPhase.AfterRestored);

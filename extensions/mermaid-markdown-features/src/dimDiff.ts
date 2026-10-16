/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Command the workbench fires when a workspace folder's git HEAD moves (a commit, a
 * checkout, a reset) and once on startup, to bring the change marks in that folder's
 * `.dim` records in line with the new HEAD. Duplicated as `SYNC_DIFFS_COMMAND` in
 * `src/vs/workbench/contrib/dim/browser/dim.contribution.ts`; keep the two in sync.
 */
export const syncDiffsCommand = '_dim.syncDiffs';

/** The folders the workbench hands the sync command; both are URI strings. */
interface IDimSyncDiffsArgs {
	/** The workspace folder the records describe. */
	readonly folderUri: string;
	/** The folder's records folder (`<folder>/.dim`). */
	readonly recordsUri: string;
}

/** The folder of agent-written big-picture records, which describe no single file and carry no change marks. */
const bigPictureFolder = 'big_picture';

/** The comment lines that wrap a removed element in a diagram's mermaid source. */
const removedStart = '%% dim:removed';
const removedEnd = '%% dim:end';

/** The parts of a `.dim` record a sync reads or rewrites; everything else is kept as it is. */
interface IDimRecordJson {
	source?: unknown;
	sourceHash?: unknown;
	diff?: { base?: unknown; new?: unknown };
	diagrams?: Array<{ mermaid?: unknown; changes?: unknown; links?: unknown } | null>;
}

/** The result of one git run: its exit code (`undefined` when git could not run) and output. */
interface IGitResult {
	readonly code: number | undefined;
	readonly stdout: string;
}

/**
 * Registers {@link syncDiffsCommand}. A record drawn while its file had changes is
 * stamped with the commit those changes were measured against (its `diff.base`, see
 * `generateDimDiagram.sh`). Once HEAD moves past that commit, each such record is
 * brought up to date without asking Claude again:
 *   - the file now matches HEAD (its changes were committed): the marks are dropped, so
 *     added and changed elements show normally and removed elements disappear;
 *   - the file still has changes, but the new commits did not touch it: the record is
 *     restamped with the new HEAD, as its marks still hold;
 *   - otherwise the marks no longer describe the file's changes: they are dropped and the
 *     record is left stale, so the next generation run draws the changes afresh.
 *
 * Node-only, like the generate command: a web extension host has no git to run.
 */
export function registerDimDiffSync(): vscode.Disposable {
	return vscode.commands.registerCommand(syncDiffsCommand, async (args: IDimSyncDiffsArgs) => {
		// See `registerDimGenerate` for why the platform check and the aliased require.
		if ((process.platform as string) === 'web') {
			return;
		}
		const nodeRequire: NodeRequire = require;
		const { execFile } = nodeRequire('child_process') as typeof import('child_process');
		const git = (cwd: string, gitArgs: readonly string[]) => new Promise<IGitResult>(resolve => {
			execFile('git', gitArgs, { cwd }, (error, stdout) => {
				resolve({ code: error ? (typeof error.code === 'number' ? error.code : undefined) : 0, stdout: stdout.toString() });
			});
		});

		const folder = vscode.Uri.parse(args.folderUri);
		const head = (await git(folder.fsPath, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
		if (!head) {
			return; // not a repository, or no commit yet
		}
		for (const recordUri of await findRecords(vscode.Uri.parse(args.recordsUri))) {
			await syncRecord(recordUri, folder, head, git);
		}
	});
}

/** Every `.dim` record under the records folder, except the big-picture ones. */
async function findRecords(dir: vscode.Uri): Promise<vscode.Uri[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}
	const records: vscode.Uri[] = [];
	for (const [name, type] of entries) {
		const child = vscode.Uri.joinPath(dir, name);
		if (type === vscode.FileType.Directory && name !== bigPictureFolder) {
			records.push(...await findRecords(child));
		} else if (type === vscode.FileType.File && name.endsWith('.dim')) {
			records.push(child);
		}
	}
	return records;
}

/** Brings one record's change marks in line with `head`, as {@link registerDimDiffSync} describes. */
async function syncRecord(recordUri: vscode.Uri, folder: vscode.Uri, head: string, git: (cwd: string, args: readonly string[]) => Promise<IGitResult>): Promise<void> {
	let record: IDimRecordJson;
	try {
		record = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(recordUri))) as IDimRecordJson;
	} catch {
		return; // missing, legacy or unreadable: nothing to sync
	}
	const base = record.diff?.base;
	if (typeof base !== 'string' || base === head || typeof record.source !== 'string') {
		return; // no marks, or they are measured against the current HEAD already
	}
	const source = vscode.Uri.joinPath(folder, record.source);
	const cwd = vscode.Uri.joinPath(source, '..').fsPath;
	const name = source.path.slice(source.path.lastIndexOf('/') + 1);

	const status = await git(cwd, ['status', '--porcelain', '--', name]);
	if (status.code === 0 && status.stdout.trim().length === 0) {
		clearChanges(record); // committed (or the file is gone): show it as it now is
	} else if ((await git(cwd, ['diff', '--quiet', base, head, '--', name])).code === 0) {
		record.diff = { ...record.diff, base: head }; // the new commits left this file alone
	} else {
		clearChanges(record);
		delete record.sourceHash; // the marks are out of date: let the next run redraw them
	}
	await vscode.workspace.fs.writeFile(recordUri, new TextEncoder().encode(JSON.stringify(record, undefined, '\t') + '\n'));
}

/**
 * Drops a record's change marks: its `diff` stamp, each diagram's `changes` list, the
 * removed elements (the lines between {@link removedStart} and {@link removedEnd}) and
 * the links to those removed elements.
 */
function clearChanges(record: IDimRecordJson): void {
	delete record.diff;
	for (const diagram of record.diagrams ?? []) {
		if (!diagram) {
			continue;
		}
		const removed = new Set(Array.isArray(diagram.changes)
			? (diagram.changes as Array<{ label?: unknown; change?: unknown } | null>).filter(change => change?.change === 'removed').map(change => change?.label)
			: []);
		if (typeof diagram.mermaid === 'string') {
			diagram.mermaid = withoutRemoved(diagram.mermaid);
		}
		if (Array.isArray(diagram.links)) {
			diagram.links = (diagram.links as Array<{ label?: unknown } | null>).filter(link => !removed.has(link?.label));
		}
		delete diagram.changes;
	}
}

/** A diagram's mermaid source without its removed elements or their marker lines. */
function withoutRemoved(mermaid: string): string {
	const kept: string[] = [];
	let depth = 0;
	for (const line of mermaid.split('\n')) {
		const text = line.trim();
		if (text === removedStart) {
			depth++;
		} else if (text === removedEnd && depth > 0) {
			depth--;
		} else if (depth === 0) {
			kept.push(line);
		}
	}
	return kept.join('\n');
}

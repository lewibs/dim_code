/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clearFileChanges } from './dimDiff';

/**
 * The git side of reviewing changes (see `dimPendingEdits.ts` in the workbench). Every change
 * not staged in git waits for review, and review is all or nothing: accepting stages every
 * change in the workspace, so the staged version of a file is what the user has accepted. Duplicated as the `REVIEW_*_COMMAND` constants in
 * `src/vs/workbench/contrib/dim/browser/dimPendingEdits.ts`; keep the two in sync.
 */
const listCommand = '_dim.review.list';
const readStagedCommand = '_dim.review.readStaged';
const stageAllCommand = '_dim.review.stageAll';

/**
 * The workbench actions run by the diagram viewer's review bar: accept every change in the
 * workspace, or reject all of the given file's changes. Defined in `dimPendingEdits.ts`.
 */
export const acceptAllCommand = 'dim.pendingEdits.acceptAll';
export const rejectAllCommand = 'dim.pendingEdits.rejectAll';

/** The records folder, whose files are Dim's own and never reviewed. */
const recordsFolder = '.dim/';

/** A file with changes waiting for review, relative to the workspace folder. */
interface IDimReviewFile {
	readonly path: string;
	/** The staged blob the changes are measured against, or `new` for a file git does not track. */
	readonly stamp: string;
}

/** The result of one git run: its exit code (`undefined` when git could not run) and output. */
interface IGitResult {
	readonly code: number | undefined;
	readonly stdout: string;
}

/**
 * Runs git in `cwd`, feeding it `input` on stdin. Node-only, like the generate command: in a
 * web extension host, which has no git to run, it reports that git could not run.
 */
export function git(cwd: string, args: readonly string[], input?: string): Promise<IGitResult> {
	// See `registerDimGenerate` for why the platform check and the aliased require.
	if ((process.platform as string) === 'web') {
		return Promise.resolve({ code: undefined, stdout: '' });
	}
	const nodeRequire: NodeRequire = require;
	const { spawn } = nodeRequire('child_process') as typeof import('child_process');
	return new Promise<IGitResult>(resolve => {
		const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', () => resolve({ code: undefined, stdout: '' }));
		child.on('close', code => resolve({ code: code ?? undefined, stdout: Buffer.concat(chunks).toString() }));
		// git may exit without reading its input; the closed pipe is not an error here.
		child.stdin.on('error', () => { });
		child.stdin.end(input ?? '');
	});
}

/** The folder a file is in, to run git from, and its name there. */
function location(file: vscode.Uri): { cwd: string; name: string } {
	return { cwd: vscode.Uri.joinPath(file, '..').fsPath, name: file.path.slice(file.path.lastIndexOf('/') + 1) };
}

/**
 * Whether a file has changes waiting for review: it differs from its staged version, or git
 * does not track it yet (and does not ignore it). False outside a git repository.
 */
export async function hasPendingChanges(file: vscode.Uri): Promise<boolean> {
	const { cwd, name } = location(file);
	const unstaged = await git(cwd, ['diff', '--quiet', '--', name]);
	if (unstaged.code === 1) {
		return true;
	}
	if (unstaged.code !== 0) {
		return false; // not in a repository
	}
	const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '--', name]);
	return untracked.stdout.trim().length > 0;
}

/**
 * Git's index (the staged versions) for the repository a file is in, or `undefined` outside
 * a git repository. Staging or committing changes it without touching the file, so watching
 * it keeps track of whether the file still has changes waiting for review.
 */
export async function gitIndexFile(file: vscode.Uri): Promise<vscode.Uri | undefined> {
	const { cwd } = location(file);
	const index = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
	const path = index.stdout.trim();
	return index.code === 0 && path ? vscode.Uri.file(path) : undefined;
}

/**
 * The files under `cwd` with changes waiting for review, relative to it, or `undefined` when
 * it is not in a git repository.
 */
async function listPending(cwd: string): Promise<IDimReviewFile[] | undefined> {
	const changed = await git(cwd, ['diff', '--raw', '--relative', '--no-renames', '--no-abbrev', '-z']);
	if (changed.code !== 0) {
		return undefined;
	}
	const files: IDimReviewFile[] = [];
	// `:<mode> <mode> <staged sha> <file sha> <status>` NUL `<path>` NUL, per file.
	const fields = changed.stdout.split('\0');
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [, mode, , stagedSha, , status] = fields[i].split(/[: ]/);
		// Deleted files have no text to review, and submodules are no files.
		if (status !== 'D' && mode !== '160000') {
			files.push({ path: fields[i + 1], stamp: stagedSha });
		}
	}
	const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
	for (const path of untracked.stdout.split('\0')) {
		if (path) {
			files.push({ path, stamp: 'new' });
		}
	}
	return files.filter(file => !file.path.startsWith(recordsFolder));
}

/**
 * Registers the review commands:
 *   - `_dim.review.list(folderUri)`: the folder's files with changes waiting for review,
 *     or `undefined` when it is not in a git repository;
 *   - `_dim.review.readStaged(fileUri)`: a file's accepted (staged) text, empty for a
 *     file git does not track;
 *   - `_dim.review.stageAll(folderUri)`: accepts every change in the folder (edits, new
 *     files and deletions) by staging it, and drops the change marks from the changed
 *     files' diagrams, which now show them as accepted.
 */
export function registerDimReview(): vscode.Disposable {
	if ((process.platform as string) === 'web') {
		return vscode.Disposable.from();
	}
	return vscode.Disposable.from(
		vscode.commands.registerCommand(listCommand, (folderUri: string) => listPending(vscode.Uri.parse(folderUri).fsPath)),
		vscode.commands.registerCommand(readStagedCommand, async (fileUri: string): Promise<string> => {
			const { cwd, name } = location(vscode.Uri.parse(fileUri));
			const staged = await git(cwd, ['show', `:./${name}`]);
			return staged.code === 0 ? staged.stdout : '';
		}),
		vscode.commands.registerCommand(stageAllCommand, async (folderUri: string): Promise<void> => {
			const folder = vscode.Uri.parse(folderUri);
			const files = await listPending(folder.fsPath);
			if (files && (await git(folder.fsPath, ['add', '--all', '--', '.'])).code === 0) {
				await Promise.all(files.map(file => clearFileChanges(vscode.Uri.joinPath(folder, file.path))));
			}
		}),
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { git } from './dimReview';

/** A file that imports the file a Dim view describes, listed under "Used By" in its README. */
export interface IDimUser {
	/** The file's path relative to the repository root. */
	readonly label: string;
	readonly uri: string;
}

/** At most this many files are read to confirm they import the file. */
const maxCandidates = 200;

/** A relative module specifier in an `import`, `export … from`, `import()` or `require()`. */
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?<specifier>\.{1,2}\/[^'"]+)['"]/g;

/** Extensions a module specifier may name or leave out. */
const moduleExtension = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Finds the files in a file's git repository that import it through a relative path,
 * sorted by path. Empty outside a git repository or when nothing imports it.
 */
export async function findDimUsers(file: vscode.Uri): Promise<IDimUser[]> {
	const dir = vscode.Uri.joinPath(file, '..');
	const root = (await git(dir.fsPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
	if (!root) {
		return [];
	}
	const target = withoutModuleExtension(file.path);
	// Every relative import of the file ends in `/<name>`, or `/<folder>` for an index
	// file imported by its folder; read only the files that have one.
	const names = target.split('/');
	const stem = names[names.length - 1] === 'index' ? names[names.length - 2] : names[names.length - 1];
	const grep = await git(root, ['grep', '-l', '-I', '--untracked', '--full-name', '-F', '-e', `/${stem}`]);
	const candidates = grep.stdout.split('\n').filter(line => line.length > 0).slice(0, maxCandidates);
	const rootUri = vscode.Uri.file(root);
	const users: IDimUser[] = [];
	for (const path of candidates) {
		const candidate = vscode.Uri.joinPath(rootUri, path);
		if (candidate.path === file.path || path.startsWith('.dim/')) {
			continue;
		}
		if (await importsFile(candidate, target)) {
			users.push({ label: path, uri: candidate.toString() });
		}
	}
	return users.sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether `candidate` imports the module at `target` (a path without its extension). */
async function importsFile(candidate: vscode.Uri, target: string): Promise<boolean> {
	let text: string;
	try {
		text = new TextDecoder().decode(await vscode.workspace.fs.readFile(candidate));
	} catch {
		return false;
	}
	const dir = vscode.Uri.joinPath(candidate, '..');
	for (const match of text.matchAll(importSpecifier)) {
		const resolved = withoutModuleExtension(vscode.Uri.joinPath(dir, match.groups!.specifier).path);
		// A folder import (`./payments`) loads the folder's index file.
		if (resolved === target || `${resolved}/index` === target) {
			return true;
		}
	}
	return false;
}

function withoutModuleExtension(path: string): string {
	return path.replace(moduleExtension, '');
}

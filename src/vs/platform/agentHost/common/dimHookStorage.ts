/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../base/common/hash.js';
import { extname, joinPath, relativePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * File extensions (lower-case, without the leading dot) that Dim treats as
 * source code and therefore gives a `.dim` change record. Everything else —
 * documentation, data and config such as `.md`, `.json`, `.txt`, and
 * extensionless files like `.gitignore` — is skipped.
 *
 * This list is mirrored by the `updateDimHook.sh` agent hook; keep the two in
 * sync so the editor and the hook agree on which files get a record.
 */
const dimCodeExtensions = new Set<string>([
	'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
	'py', 'pyw', 'pyi',
	'java', 'kt', 'kts', 'scala', 'groovy',
	'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
	'cs', 'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm',
	'sh', 'bash', 'zsh', 'fish',
	'pl', 'pm', 'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hs', 'fs', 'fsx', 'vb', 'clj', 'cljs',
	'sql', 'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'sass', 'less'
]);

/**
 * Whether a file is a source-code file that Dim should give a `.dim` change
 * record. Matching is by file extension against {@link dimCodeExtensions}.
 *
 * @param file The file to classify.
 */
export function isDimCodeFile(file: URI): boolean {
	const ext = extname(file).replace(/^\./, '').toLowerCase();
	return ext.length > 0 && dimCodeExtensions.has(ext);
}

/**
 * Resolves the directory where the Dim `updateDimHook` agent hook writes its
 * per-file `.dim` change records for a given workspace folder.
 *
 * The records are kept out of the repository and under the user-data root at
 * `<workspaceStorageHome>/dim/<key>`, so a project folder is never polluted with
 * generated files. `<key>` is a stable, non-cryptographic hash of the folder's
 * URI rather than VS Code's own per-workspace storage id: that id salts in the
 * folder's filesystem `ctime`, which is only reachable inside the workbench, so
 * a parallel `dim/` bucket lets both the native agent session and the
 * standalone CLI terminal agree on the same location from different layers.
 *
 * @param workspaceStorageHome The `workspaceStorageHome` from the environment service.
 * @param workspaceFolder The opened workspace folder the records belong to.
 */
export function dimHookStorageDir(workspaceStorageHome: URI, workspaceFolder: URI): URI {
	const key = (stringHash(workspaceFolder.toString(), 0) >>> 0).toString(16);
	return joinPath(workspaceStorageHome, 'dim', key);
}

/**
 * Resolves the `.dim` change record that the Dim `updateDimHook` agent hook
 * writes for a given workspace file, or `undefined` when the file does not live
 * inside the workspace folder.
 *
 * The record mirrors the file's workspace-relative path with a `.dim` suffix
 * under {@link dimHookStorageDir}, matching the hook's layout
 * (`src/foo.ts` -> `<dir>/src/foo.ts.dim`). This is the TypeScript counterpart of
 * the path the hook builds from `git status`, so callers that redirect a file
 * open to its record resolve the same location the hook wrote.
 *
 * @param workspaceStorageHome The `workspaceStorageHome` from the environment service.
 * @param workspaceFolder The workspace folder the file belongs to.
 * @param file The workspace file whose change record is wanted.
 */
export function dimHookRecordUri(workspaceStorageHome: URI, workspaceFolder: URI, file: URI): URI | undefined {
	const relative = relativePath(workspaceFolder, file);
	if (relative === undefined || relative.length === 0 || relative.startsWith('..')) {
		return undefined; // the file is outside the workspace folder
	}
	return joinPath(dimHookStorageDir(workspaceStorageHome, workspaceFolder), `${relative}.dim`);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { stringHash } from '../../../base/common/hash.js';
import { extname, extUri, joinPath, relativePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { DimDiagramType, dimDiagramLabel, inferDimDiagramType } from './dimDiagramTypes.js';

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
 * One diagram stored inside a `.dim` record: its {@link DimDiagramType}, a short
 * UI label for the viewer's toggle button, and the mermaid source to render.
 */
export interface IDimDiagram {
	readonly type: DimDiagramType;
	readonly label: string;
	readonly mermaid: string;
}

/**
 * The on-disk shape of a `.dim` record: a small JSON container holding one or
 * more diagrams, so a single file can offer several views (structure, behavior,
 * …) that the viewer exposes as a toggle button group.
 */
export interface IDimRecord {
	readonly version: number;
	/**
	 * Workspace-relative path of the source file this record describes (e.g.
	 * `src/foo.ts` for `src/foo.ts.dim`). Lets the viewer offer a "Raw" view of
	 * the associated file. Optional so legacy records keep parsing.
	 */
	readonly source?: string;
	/**
	 * Content hash of the source file at the time the diagrams were generated, used
	 * by the `generateDimDiagram.sh` generator to skip a file whose code is unchanged.
	 * Written only by that generator (the editor's placeholder seed omits it, so a
	 * seeded record is always treated as stale and regenerated). Optional so seeded and
	 * legacy records keep parsing.
	 */
	readonly sourceHash?: string;
	readonly diagrams: readonly IDimDiagram[];
}

/** Current `.dim` record format version. Bump when the JSON shape changes. */
export const DIM_RECORD_VERSION = 1;

/**
 * The view type the `mermaid-markdown-features` extension registers its `.dim`
 * custom editor under. Duplicated from `dimEditorViewType` in that extension,
 * which cannot import platform sources; keep the two in sync. Used to force a
 * `.dim` record open with the diagram viewer rather than a plain text editor.
 */
export const DIM_EDITOR_VIEW_TYPE = 'vscode.mermaid-markdown-features.dimEditor';

/**
 * Parses the contents of a `.dim` file into its list of diagrams. Accepts both
 * the JSON {@link IDimRecord} container and a legacy record whose entire content
 * is a single block of raw mermaid source (which becomes a one-diagram list, its
 * type inferred from the opening keyword), so older records keep rendering.
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimRecord(content: string): IDimDiagram[] {
	const trimmed = content.trimStart();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(content) as Partial<IDimRecord>;
			if (parsed && Array.isArray(parsed.diagrams)) {
				return parsed.diagrams
					.filter(d => d && typeof d.mermaid === 'string')
					.map(d => {
						const type = (d.type as DimDiagramType) ?? inferDimDiagramType(d.mermaid);
						return { type, label: d.label || dimDiagramLabel(type), mermaid: d.mermaid };
					});
			}
		} catch {
			// Not valid JSON; fall through and treat the whole file as raw mermaid.
		}
	}
	const type = inferDimDiagramType(content);
	return [{ type, label: dimDiagramLabel(type), mermaid: content }];
}

/**
 * Extracts the workspace-relative `source` path recorded in a `.dim` file's JSON
 * container, or `undefined` for a legacy raw-mermaid record or one that stored no
 * source. Lets a caller map a `.dim` record back to the file it describes (e.g. to
 * offer a "Raw" view of that file).
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimRecordSource(content: string): string | undefined {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(content) as Partial<IDimRecord>;
		return typeof parsed.source === 'string' ? parsed.source : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Serializes a list of diagrams into the JSON {@link IDimRecord} text written to a
 * `.dim` file.
 *
 * @param diagrams The diagrams to store.
 * @param source Workspace-relative path of the source file the record describes,
 * recorded so the viewer can offer a "Raw" view of it. Omitted when unknown.
 */
export function serializeDimRecord(diagrams: readonly IDimDiagram[], source?: string): string {
	const record: IDimRecord = { version: DIM_RECORD_VERSION, source, diagrams };
	return JSON.stringify(record, undefined, '\t');
}

/**
 * Placeholder diagrams seeded into a freshly created `.dim` record until the agent
 * fills them in: a structural view and a behavioral view, so the viewer shows its
 * toggle group out of the box. Mirrored by the `updateDimHook.sh` agent hook;
 * keep the two in sync.
 */
export const dimPlaceholderDiagrams: readonly IDimDiagram[] = [
	{
		type: DimDiagramType.Class,
		label: dimDiagramLabel(DimDiagramType.Class),
		mermaid: `classDiagram
	class Example {
		+String name
		+doWork() void
	}
	class Helper {
		+assist() void
	}
	Example --> Helper : uses
`,
	},
	{
		type: DimDiagramType.Sequence,
		label: dimDiagramLabel(DimDiagramType.Sequence),
		mermaid: `sequenceDiagram
	participant Example
	participant Helper
	Example->>Helper: assist()
	Helper-->>Example: result
`,
	},
];

/**
 * The serialized {@link IDimRecord} text seeded into a freshly created `.dim`
 * record. Written by the editor when it redirects a file open to a missing
 * record; mirrored by the `updateDimHook.sh` agent hook.
 */
export const dimPlaceholderRecordContent = serializeDimRecord(dimPlaceholderDiagrams);

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

/**
 * Resolves the source file a `.dim` change record describes, reversing
 * {@link dimHookRecordUri}: given a record under {@link dimHookStorageDir} for one
 * of the open workspace folders, returns the workspace file it mirrors. Returns
 * `undefined` when the URI is not a `.dim` record under any of those folders'
 * storage directories.
 *
 * This lets the diagram viewer present itself as its source file (tab, breadcrumbs)
 * even though the editor is opened on the hidden record under the storage root.
 *
 * @param workspaceStorageHome The `workspaceStorageHome` from the environment service.
 * @param workspaceFolders The opened workspace folders to resolve against.
 * @param record The `.dim` record URI to map back to its source file.
 */
export function dimSourceFromRecordUri(workspaceStorageHome: URI, workspaceFolders: readonly URI[], record: URI): URI | undefined {
	if (!record.path.endsWith('.dim')) {
		return undefined;
	}
	for (const folder of workspaceFolders) {
		const relative = relativePath(dimHookStorageDir(workspaceStorageHome, folder), record);
		if (relative === undefined || relative.length === 0 || relative.startsWith('..')) {
			continue; // not under this folder's record directory
		}
		return joinPath(folder, relative.slice(0, -'.dim'.length));
	}
	return undefined;
}

/**
 * Ensures the `.dim` change record for a source file exists, seeding a placeholder
 * record (so the diagram view toggle has something to offer) when neither the agent
 * hook nor a previous call has written one yet. Idempotent: a record that already
 * exists is left untouched, and a losing race to create one is ignored.
 *
 * Returns the record URI, or `undefined` when the file gets no record: it is not a
 * source-code file, it lives outside the workspace folder, or it is itself a record
 * under the storage root. Shared by the editor-open seeding and the view toggle so
 * that a restored editor on window load also gets its record, not only a fresh open.
 *
 * @param fileService The file service used to probe for and create the record.
 * @param workspaceStorageHome The `workspaceStorageHome` from the environment service.
 * @param workspaceFolder The workspace folder the file belongs to.
 * @param file The workspace source file whose record should be ensured.
 */
export async function seedDimRecord(fileService: IFileService, workspaceStorageHome: URI, workspaceFolder: URI, file: URI): Promise<URI | undefined> {
	if (!isDimCodeFile(file)) {
		return undefined; // only source-code files get a record
	}
	if (extUri.isEqualOrParent(file, workspaceStorageHome)) {
		return undefined; // already under the storage root: never seed a record for a record
	}
	const record = dimHookRecordUri(workspaceStorageHome, workspaceFolder, file);
	if (!record) {
		return undefined; // the file is outside the workspace folder
	}
	if (!(await fileService.exists(record))) {
		// Record the file's workspace-relative path so the viewer can map the record
		// back to its source file (and offer a "Raw" view of it).
		const source = relativePath(workspaceFolder, file);
		try {
			await fileService.createFile(record, VSBuffer.fromString(serializeDimRecord(dimPlaceholderDiagrams, source)));
		} catch {
			// A concurrent seed may have created it first; the record now exists either way.
		}
	}
	return record;
}

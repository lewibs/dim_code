/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { extname, extUri, joinPath, relativePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { DimDiagramType, dimDiagramLabel, dimDiagramTypes, inferDimDiagramType } from './dimDiagramTypes.js';

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
	 * Written only by that generator (the editor's empty seed omits it, so a seeded
	 * record is always treated as stale and regenerated). Optional so seeded and
	 * legacy records keep parsing.
	 */
	readonly sourceHash?: string;
	/**
	 * A short, plain-English overview of what the source file does, shown in the
	 * viewer's always-available "README" view. Written by the generator alongside the
	 * diagrams; omitted on a freshly seeded or failed record, in which case the viewer
	 * shows a "being generated" placeholder message instead. Optional so seeded and
	 * legacy records keep parsing.
	 */
	readonly readme?: string;
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
						// A type outside the catalog (e.g. `stateDiagram-v2`, the mermaid keyword
						// rather than the catalog's) is read from the diagram's own keyword.
						const type = dimDiagramTypes.includes(d.type) ? d.type : inferDimDiagramType(d.mermaid);
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
 * @param readme A short overview of the file for the viewer's README view. Omitted
 * when none has been generated yet (`JSON.stringify` drops the undefined field).
 */
export function serializeDimRecord(diagrams: readonly IDimDiagram[], source?: string, readme?: string): string {
	const record: IDimRecord = { version: DIM_RECORD_VERSION, source, readme, diagrams };
	return JSON.stringify(record, undefined, '\t');
}

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
 * The kind of code entity a focused Dim view describes: a class (or interface, type,
 * enum), a function or method, or an attribute (a field / property / parameter of a
 * class, drawn as the state machine of the values it moves through).
 */
export type DimFocusKind = 'class' | 'function' | 'attribute';

/**
 * A Dim view focused on one symbol of a source file rather than the whole file, e.g.
 * `{ kind: 'attribute', symbol: 'Session.state' }`. Opened by clicking that symbol in
 * a diagram. Encoded in the source URI's fragment (see {@link parseDimFocus}), and
 * stored in its own record next to the file's (see {@link dimHookRecordUri}).
 */
export interface IDimFocus {
	readonly kind: DimFocusKind;
	/** The symbol, qualified by its owner for a member: `Owner.member`. */
	readonly symbol: string;
}

/**
 * The fragment of a focused source URI: `<kind>:<symbol>`, with the symbol made of
 * dotted identifiers so it is safe in a file name. Mirrored by `formatDimFocus` in the
 * `mermaid-markdown-features` extension and by `generateDimDiagram.sh`; keep the three in sync.
 */
const dimFocusPattern = /^(?<kind>class|function|attribute):(?<symbol>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;

/**
 * Reads the {@link IDimFocus} a source URI carries in its fragment, or `undefined` for
 * a plain (whole-file) source URI or a fragment that is not a Dim focus.
 *
 * @param uri The source file URI, possibly with a `<kind>:<symbol>` fragment.
 */
export function parseDimFocus(uri: URI): IDimFocus | undefined {
	const groups = dimFocusPattern.exec(uri.fragment)?.groups;
	return groups ? { kind: groups.kind as DimFocusKind, symbol: groups.symbol } : undefined;
}

/**
 * The folder, at the root of each workspace folder, that holds its `.dim` records.
 * Mirrored by `updateDimHook.sh` (via `DIM_DIM_DIR`); keep the two in sync.
 */
const dimRecordsFolderName = '.dim';

/**
 * The contents of the `.gitignore` kept in a records folder while the records are
 * not committed. `*` matches everything in the folder, the `.gitignore` itself
 * included, so git ignores the whole folder without the project's own `.gitignore`
 * being touched.
 */
const dimRecordsGitignore = '# Dim diagram records. Turn off the "dim.diagrams.gitignore" setting to commit them with the code.\n*\n';

/**
 * Resolves the directory holding the `.dim` change records for a given workspace
 * folder: `<workspaceFolder>/.dim`.
 *
 * The records live with the code so they survive app restarts, rebuilds and resets of
 * the user-data folder (VS Code's workspace-storage cleaner deletes any unrecognized
 * folder there on every launch). By default the folder ignores itself in git (see
 * {@link syncDimRecordsGitignore}) unless the user chooses to commit it.
 *
 * @param workspaceFolder The opened workspace folder the records belong to.
 */
export function dimHookStorageDir(workspaceFolder: URI): URI {
	return joinPath(workspaceFolder, dimRecordsFolderName);
}

/**
 * The folder, inside the records folder, that holds "big picture" records: `.dim`
 * records an agent writes to answer a question that spans several files (how a feature
 * flows, how subsystems fit together). Unlike a per-file record, a big-picture record
 * describes no single source file; it is opened directly in the diagram viewer, its
 * README says what the diagrams show and its diagrams' links point at the files
 * involved. Mirrored by the `mermaid-markdown-features` extension (its `.dim` editor
 * selector and `isBigPictureRecord`) and the `big-picture` skill; keep them in sync.
 */
const dimBigPictureFolderName = 'big_picture';

/**
 * Resolves the directory holding a workspace folder's big-picture records:
 * `<workspaceFolder>/.dim/big_picture`.
 *
 * @param workspaceFolder The opened workspace folder the records belong to.
 */
export function dimBigPictureDir(workspaceFolder: URI): URI {
	return joinPath(dimHookStorageDir(workspaceFolder), dimBigPictureFolderName);
}

/**
 * Whether a URI is a big-picture `.dim` record (see {@link dimBigPictureDir}) of one of
 * the given workspace folders.
 *
 * @param workspaceFolders The opened workspace folders to check against.
 * @param uri The URI to classify.
 */
export function isDimBigPictureRecord(workspaceFolders: readonly URI[], uri: URI): boolean {
	return uri.path.endsWith('.dim') && workspaceFolders.some(folder => extUri.isEqualOrParent(uri, dimBigPictureDir(folder)) && !extUri.isEqual(uri, dimBigPictureDir(folder)));
}

/**
 * Adds or removes the `.gitignore` in a workspace folder's records folder, so git
 * ignores the records (`ignoreInGit`) or sees them for committing. With
 * `ignoreInGit`, this creates the records folder if needed; otherwise it never
 * creates anything. Errors are swallowed: a concurrent call may have won the race,
 * and the next sync converges either way.
 *
 * @param fileService The file service used to probe for and write the file.
 * @param workspaceFolder The workspace folder whose records folder to update.
 * @param ignoreInGit Whether git should ignore the records (the `.gitignore` exists).
 */
export async function syncDimRecordsGitignore(fileService: IFileService, workspaceFolder: URI, ignoreInGit: boolean): Promise<void> {
	const gitignore = joinPath(dimHookStorageDir(workspaceFolder), '.gitignore');
	try {
		const exists = await fileService.exists(gitignore);
		if (ignoreInGit && !exists) {
			await fileService.createFile(gitignore, VSBuffer.fromString(dimRecordsGitignore), { overwrite: false });
		} else if (!ignoreInGit && exists) {
			await fileService.del(gitignore);
		}
	} catch {
		// See above: another sync got there first.
	}
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
 * A source URI focused on one symbol (see {@link parseDimFocus}) gets its own record
 * next to the file's, named after the symbol: `src/foo.ts#Foo.state` ->
 * `<dir>/src/foo.ts#Foo.state.dim`.
 *
 * @param workspaceFolder The workspace folder the file belongs to.
 * @param file The workspace file whose change record is wanted.
 */
export function dimHookRecordUri(workspaceFolder: URI, file: URI): URI | undefined {
	const relative = relativePath(workspaceFolder, file);
	if (relative === undefined || relative.length === 0 || relative.startsWith('..')) {
		return undefined; // the file is outside the workspace folder
	}
	const focus = parseDimFocus(file);
	return joinPath(dimHookStorageDir(workspaceFolder), focus ? `${relative}#${focus.symbol}.dim` : `${relative}.dim`);
}

/**
 * Resolves the source file a `.dim` change record describes, reversing
 * {@link dimHookRecordUri}: given a record under {@link dimHookStorageDir} for one
 * of the open workspace folders, returns the workspace file it mirrors. Returns
 * `undefined` when the URI is not a `.dim` record under any of those folders'
 * storage directories, or is a big-picture record (see {@link dimBigPictureDir}),
 * which describes no single source file.
 *
 * This lets the diagram viewer present itself as its source file (tab, breadcrumbs)
 * even though the editor is opened on the record in the records folder.
 *
 * @param workspaceFolders The opened workspace folders to resolve against.
 * @param record The `.dim` record URI to map back to its source file.
 */
export function dimSourceFromRecordUri(workspaceFolders: readonly URI[], record: URI): URI | undefined {
	if (!record.path.endsWith('.dim') || isDimBigPictureRecord(workspaceFolders, record)) {
		return undefined;
	}
	for (const folder of workspaceFolders) {
		const relative = relativePath(dimHookStorageDir(folder), record);
		if (relative === undefined || relative.length === 0 || relative.startsWith('..')) {
			continue; // not under this folder's record directory
		}
		// A focused record (`foo.ts#Foo.state.dim`) describes part of the same file.
		const source = relative.slice(0, -'.dim'.length);
		const hash = source.indexOf('#');
		return joinPath(folder, hash >= 0 ? source.slice(0, hash) : source);
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
 * source-code file, it lives outside the workspace folder, or it is inside the
 * records folder. Shared by the editor-open seeding and the view toggle so that a
 * restored editor on window load also gets its record, not only a fresh open.
 *
 * @param fileService The file service used to probe for and create the record.
 * @param workspaceFolder The workspace folder the file belongs to.
 * @param file The workspace source file whose record should be ensured.
 * @param ignoreInGit Whether git should ignore the records folder; applied when a
 * record is seeded (see {@link syncDimRecordsGitignore}).
 */
export async function seedDimRecord(fileService: IFileService, workspaceFolder: URI, file: URI, ignoreInGit: boolean): Promise<URI | undefined> {
	if (!isDimCodeFile(file)) {
		return undefined; // only source-code files get a record
	}
	if (extUri.isEqualOrParent(file.with({ fragment: '' }), dimHookStorageDir(workspaceFolder))) {
		return undefined; // inside the records folder: never seed a record for a record
	}
	const record = dimHookRecordUri(workspaceFolder, file);
	if (!record) {
		return undefined; // the file is outside the workspace folder
	}
	if (!(await fileService.exists(record))) {
		await syncDimRecordsGitignore(fileService, workspaceFolder, ignoreInGit);
		// Seed an empty record (no diagrams): the file shows as raw source until the
		// generator fills in a diagram chosen from its actual code, so no placeholder or
		// default diagram is ever shown. The workspace-relative path is recorded so the
		// viewer can map the record back to its source file (and offer a "Raw" view of it).
		const source = relativePath(workspaceFolder, file);
		try {
			await fileService.createFile(record, VSBuffer.fromString(serializeDimRecord([], source)));
		} catch {
			// A concurrent seed may have created it first; the record now exists either way.
		}
	}
	return record;
}

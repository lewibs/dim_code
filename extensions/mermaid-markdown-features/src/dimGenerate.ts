/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Command the workbench runs, on opening a source file, to (re)generate that file's
 * companion `.dim` diagram record. Diagram generation needs a child process (it
 * shells out to the bundled generator, which calls the Claude CLI), which only the
 * extension host — not the workbench renderer — can spawn, so the workbench fires
 * this command and the handler here does the spawn.
 *
 * Duplicated as `GENERATE_RECORD_COMMAND` in the workbench `dim.contribution`; keep
 * the two in sync.
 */
export const generateRecordCommand = '_dim.generateRecord';

/** The paths the workbench hands the generate command; all are URI strings. */
interface IDimGenerateArgs {
	/** The bundled `generateDimDiagram.sh` generator script. */
	readonly scriptUri: string;
	/** The source file to describe. */
	readonly sourceUri: string;
	/** The `.dim` record to (re)write. */
	readonly recordUri: string;
	/** The source file's workspace-relative path, stored inside the record. */
	readonly relPath: string;
}

/**
 * Registers {@link generateRecordCommand}. The handler shells out to the bundled
 * generator, which is responsible for deciding the diagram type and for skipping
 * work when the record is already up to date, so this stays a thin spawn. It
 * resolves when the generator exits (so the caller can serialize runs) and never
 * rejects: generation is best-effort, and any open diagram view picks up the new
 * record through its own file watcher.
 *
 * Node-only: in a web extension host there is no child process to spawn. The build
 * replaces `process.platform` with `"web"` there, so the guard below is constant and
 * esbuild drops the `require` from the web bundle.
 */
export function registerDimGenerate(): vscode.Disposable {
	return vscode.commands.registerCommand(generateRecordCommand, (args: IDimGenerateArgs) => new Promise<void>(resolve => {
		// The build replaces `process.platform` with the literal `"web"` in the web
		// bundle (`NodeJS.Platform` never includes it, hence the cast), making this a
		// constant-true branch there, so esbuild dead-code-eliminates the rest of this
		// handler. In a node host the branch is false and the generator is spawned.
		if ((process.platform as string) === 'web') {
			resolve(); // no child process available in a web extension host
			return;
		}
		// Acquire `child_process` through an alias rather than a literal `require(...)`:
		// esbuild resolves a literal require eagerly (before the dead-code pass above),
		// which would break the web bundle; an aliased call survives to that pass and is
		// dropped there, while the node bundle keeps it.
		const nodeRequire: NodeRequire = require;
		const { spawn } = nodeRequire('child_process') as typeof import('child_process');
		const scriptPath = vscode.Uri.parse(args.scriptUri).fsPath;
		const sourcePath = vscode.Uri.parse(args.sourceUri).fsPath;
		const recordPath = vscode.Uri.parse(args.recordUri).fsPath;
		const child = spawn('/bin/sh', [scriptPath, sourcePath, recordPath, args.relPath], { stdio: 'ignore' });
		child.on('close', () => resolve());
		child.on('error', () => resolve());
	}));
}

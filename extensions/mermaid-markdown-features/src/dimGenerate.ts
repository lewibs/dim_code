/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Disposable } from './util/dispose';

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

/**
 * How long a run must last before it is reported as running. A run for an unchanged
 * file exits almost at once, and reporting it would just flash a progress banner.
 */
const runningReportDelay = 500;

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
	/** For a view focused on one symbol: its kind (`class`, `function` or `attribute`). */
	readonly focusKind?: string;
	/** For a view focused on one symbol: the symbol, e.g. `Session.state`. */
	readonly focusSymbol?: string;
	/**
	 * The URI the run's state is recorded under, which is what its viewer is keyed by;
	 * `sourceUri` when omitted. The changes diagram describes the whole workspace folder,
	 * so it reports under its record.
	 */
	readonly statusUri?: string;
}

/**
 * The step a running generation is on, as announced by the generator's
 * `DIM_PROGRESS <step>` lines (`starting` until the first one arrives). Keep in sync
 * with the `progress` calls in `generateDimDiagram.sh`.
 */
export type DimGenerationStep = 'starting' | 'reading' | 'claude' | 'checking' | 'fixing' | 'saving';

const dimGenerationSteps: readonly DimGenerationStep[] = ['starting', 'reading', 'claude', 'checking', 'fixing', 'saving'];

/**
 * The state of a source file's latest generation run, for the Dim editor to show.
 * A file with no state has either never been generated in this session or its last
 * run succeeded (or found nothing to do); its record on disk then speaks for itself.
 */
export type DimGenerationState =
	| { readonly kind: 'running'; readonly step: DimGenerationStep; readonly startedAt: number }
	| { readonly kind: 'failed'; readonly message: string };

/**
 * Tracks the generation state of each source file, keyed by source URI string, so an
 * open Dim editor can show progress while Claude works and say why a run failed.
 */
export class DimGenerationStatus extends Disposable {

	private readonly _states = new Map<string, DimGenerationState>();

	private readonly _onDidChange = this._register(new vscode.EventEmitter<string>());
	/** Fires with the source URI string whose state changed. */
	public readonly onDidChange = this._onDidChange.event;

	/** The state of the given source file's latest run, if it is running or failed. */
	public get(sourceUri: string): DimGenerationState | undefined {
		return this._states.get(sourceUri);
	}

	/** Records (or, with `undefined`, clears) a source file's state and announces it. */
	public set(sourceUri: string, state: DimGenerationState | undefined): void {
		if (state) {
			this._states.set(sourceUri, state);
		} else if (!this._states.delete(sourceUri)) {
			return; // nothing changed
		}
		this._onDidChange.fire(sourceUri);
	}
}

/**
 * Registers {@link generateRecordCommand}. The handler shells out to the bundled
 * generator, which is responsible for deciding the diagram type and for skipping
 * work when the record is already up to date, so this stays a thin spawn. It
 * resolves when the generator exits (so the caller can serialize runs) and never
 * rejects: generation is best-effort, and any open diagram view picks up the new
 * record through its own file watcher. Progress and failures are reported to
 * `status`, which the Dim editor shows.
 *
 * Node-only: in a web extension host there is no child process to spawn. The build
 * replaces `process.platform` with `"web"` there, so the guard below is constant and
 * esbuild drops the `require` from the web bundle.
 *
 * @param extensionUri This extension's folder, whose `node_modules` holds Mermaid.
 * @param status Where the state of each run is recorded.
 */
export function registerDimGenerate(extensionUri: vscode.Uri, status: DimGenerationStatus): vscode.Disposable {
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
		const sourceKey = vscode.Uri.parse(args.statusUri ?? args.sourceUri).toString();
		const scriptPath = vscode.Uri.parse(args.scriptUri).fsPath;
		const sourcePath = vscode.Uri.parse(args.sourceUri).fsPath;
		const recordPath = vscode.Uri.parse(args.recordUri).fsPath;

		// Progress is reported once the run has lasted `runningReportDelay`, and from then
		// on each time the generator starts a new step.
		const startedAt = Date.now();
		let step: DimGenerationStep = 'starting';
		let reported = false;
		const reportProgress = (): void => {
			reported = true;
			status.set(sourceKey, { kind: 'running', step, startedAt });
		};
		const reportRunning = setTimeout(reportProgress, runningReportDelay);
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (state: DimGenerationState | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(reportRunning);
			status.set(sourceKey, state);
			resolve();
		};

		const focusArgs = args.focusKind && args.focusSymbol ? [args.focusKind, args.focusSymbol] : [];
		// The generator checks that the diagrams build with the Mermaid package this
		// extension renders them with, run by this host's own Node (Electron as Node), so
		// neither has to be found on the user's PATH.
		const env = {
			...process.env,
			DIM_NODE: process.execPath,
			ELECTRON_RUN_AS_NODE: '1',
			DIM_MERMAID_DIR: vscode.Uri.joinPath(extensionUri, 'node_modules').fsPath,
		};
		const child = spawn('/bin/sh', [scriptPath, sourcePath, recordPath, args.relPath, ...focusArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
			const lines = stdout.split('\n');
			stdout = lines.pop() ?? ''; // keep a partial last line for the next chunk
			for (const line of lines) {
				const next = /^DIM_PROGRESS (?<step>\w+)/.exec(line)?.groups?.step as DimGenerationStep | undefined;
				if (next && dimGenerationSteps.includes(next) && next !== step) {
					step = next;
					if (reported) {
						reportProgress();
					}
				}
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < 1000) {
				stderr += chunk.toString();
			}
		});
		child.on('close', code => finish(code === 0 ? undefined : { kind: 'failed', message: describeFailure(code, stderr.trim()) }));
		child.on('error', err => finish({ kind: 'failed', message: vscode.l10n.t("The diagram generator could not be started: {0}", err.message) }));
	}));
}

/**
 * Turns the generator's exit status (see the code table in `generateDimDiagram.sh`)
 * into a message for the Dim editor.
 *
 * @param code The generator's exit code (`null` when it was killed by a signal).
 * @param detail What the generator wrote to stderr, e.g. Claude's own error.
 */
function describeFailure(code: number | null, detail: string): string {
	switch (code) {
		case 3: return vscode.l10n.t("The Claude CLI (claude) was not found. Install it or add it to your PATH.");
		case 5: return detail
			? vscode.l10n.t("Claude exited with an error: {0}", detail)
			: vscode.l10n.t("Claude exited with an error.");
		case 6: return vscode.l10n.t("Claude's reply was not in the expected format.");
		default: return vscode.l10n.t("The diagram generator failed (exit code {0}).", String(code));
	}
}

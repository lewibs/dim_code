/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { FileAccess } from '../../../../../base/common/network.js';

/**
 * Absolute path to the bundled Dim agent hook script. It ships inside the
 * editor (co-located with the compiled sources and copied to `out/` by the
 * build), so it is available in every Dim build for every workspace without any
 * dependency on `~/.claude`.
 */
function dimHookScriptPath(): string {
	return FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/updateDimHook.sh').fsPath;
}

/**
 * Runtime context the Dim agent hook needs to record per-file `.dim` changes.
 */
export interface IDimHookContext {
	/** Workspace root the hook runs in, so its `git` sees the project repo. */
	readonly workspaceDir?: string;
	/** Directory the hook writes per-file `.dim` change records under. */
	readonly dimStorageDir?: string;
}

/**
 * Build the unconditional Dim `Stop` hook matcher. Starts the bundled
 * {@link dimHookScriptPath} shell script in the background (without waiting for
 * it) once when a Claude session finishes a turn, so it can record a `.dim`
 * change record for each file updated during the turn, and routes the script's output to {@link log} so it is visible in
 * the Dim Claude log channel. Baked into {@link buildOptions} so it applies in
 * every Dim build regardless of the opened workspace.
 */
export function dimDefaultHookGroup(log: (data: string) => void, context: IDimHookContext = {}): HookCallbackMatcher {
	const scriptPath = dimHookScriptPath();
	return {
		hooks: [async () => {
			// Diagram generation calls Claude per changed file and can take a while, so run it
			// in the background instead of holding the turn open until it finishes.
			// The generator checks that the diagrams build with Node; hand it this process's
			// own (Electron as Node), so it need not be on the user's PATH.
			const env: NodeJS.ProcessEnv = { ...process.env, DIM_NODE: process.execPath, ELECTRON_RUN_AS_NODE: '1' };
			if (context.dimStorageDir) {
				env.DIM_DIM_DIR = context.dimStorageDir;
			}
			const child = spawn('/bin/sh', [scriptPath], { cwd: context.workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout?.on('data', data => log(`[Dim hook] ${String(data).trimEnd()}`));
			child.stderr?.on('data', data => log(`[Dim hook] ${String(data).trimEnd()}`));
			child.on('error', err => log(`[Dim hook] failed: ${err.message}`));
			return {};
		}],
	};
}

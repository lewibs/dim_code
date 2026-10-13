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
	return FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/onAgentEvent.sh').fsPath;
}

/**
 * Build the unconditional Dim `PreToolUse` hook matcher. Fires the bundled
 * {@link dimHookScriptPath} shell script on every tool-use event of every
 * Claude session and routes its output to {@link log} so it is visible in the
 * Dim Claude log channel. Baked into {@link buildOptions} so it applies in
 * every Dim build regardless of the opened workspace.
 */
export function dimDefaultHookGroup(log: (data: string) => void): HookCallbackMatcher {
	const scriptPath = dimHookScriptPath();
	return {
		hooks: [async () => {
			await new Promise<void>(resolve => {
				const child = spawn('/bin/sh', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
				child.stdout?.on('data', data => log(`[Dim hook] ${String(data).trimEnd()}`));
				child.stderr?.on('data', data => log(`[Dim hook] ${String(data).trimEnd()}`));
				child.on('close', () => resolve());
				child.on('error', err => { log(`[Dim hook] failed: ${err.message}`); resolve(); });
			});
			return {};
		}],
	};
}

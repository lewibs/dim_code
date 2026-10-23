/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * The command every Claude run Dim starts goes through: the Claude Code terminal's session,
 * and the headless runs that draw diagrams. `${pluginDir}` stands for Dim's built-in plugin
 * folder (skills and hooks), quoted for the shell.
 */
export const CLAUDE_START_COMMAND_SETTING = 'dim.startCommand';
export const CLAUDE_START_COMMAND_PLUGIN_DIR_VARIABLE = '${pluginDir}';
export const CLAUDE_DEFAULT_START_COMMAND = `claude --plugin-dir ${CLAUDE_START_COMMAND_PLUGIN_DIR_VARIABLE}`;

/**
 * The environment variable that hands the headless start command (see
 * {@link getHeadlessClaudeStartCommand}) to Dim's diagram generator scripts, which run
 * Claude through it. Mirrored by `generateDimDiagram.sh` and `generateDimChanges.sh`.
 */
export const CLAUDE_START_COMMAND_ENV = 'DIM_START_COMMAND';

/**
 * Builds the shell command that starts Claude from the user's start command, filling in
 * `${pluginDir}` with the quoted plugin folder. Without a plugin folder the
 * `--plugin-dir ${pluginDir}` argument is dropped, so the command still runs.
 *
 * @param startCommand The configured start command.
 * @param pluginRoot Dim's built-in plugin folder, if there is one.
 */
export function resolveClaudeStartCommand(startCommand: string, pluginRoot: URI | undefined): string {
	if (!pluginRoot) {
		return startCommand.split(` --plugin-dir ${CLAUDE_START_COMMAND_PLUGIN_DIR_VARIABLE}`).join('').split(CLAUDE_START_COMMAND_PLUGIN_DIR_VARIABLE).join('');
	}
	const quoted = `'${pluginRoot.fsPath.replace(/'/g, `'\\''`)}'`;
	return startCommand.split(CLAUDE_START_COMMAND_PLUGIN_DIR_VARIABLE).join(quoted);
}

/** The configured start command, or the default when the setting is empty. */
export function getClaudeStartCommand(configurationService: IConfigurationService): string {
	return configurationService.getValue<string>(CLAUDE_START_COMMAND_SETTING)?.trim() || CLAUDE_DEFAULT_START_COMMAND;
}

/**
 * The start command for headless Claude runs (diagram generation), which append their own
 * arguments to its last line. Dim's plugin folder is left out: its Stop hook draws diagrams,
 * so loading it in a run that draws diagrams would start another run after every one.
 */
export function getHeadlessClaudeStartCommand(configurationService: IConfigurationService): string {
	return resolveClaudeStartCommand(getClaudeStartCommand(configurationService), undefined).trim();
}

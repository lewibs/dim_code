/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { FileAccess } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, EditPresentationTypes, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { dimHookStorageDir } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

// --- Dim: Claude Code terminal (default secondary side bar content) ---
//
// The right (secondary) side bar opens by default to a single integrated terminal that runs the
// Claude Code CLI (`claude`). It replaces the hidden agent chat panel as the default aux-bar view
// and is bound to Ctrl+Alt+I (see `openCommandActionDescriptor` below). There is exactly one Claude
// terminal per window: the view pane owns a single terminal instance and recreates it only if the
// underlying shell session exits.

export const CLAUDE_TERMINAL_VIEW_CONTAINER_ID = 'workbench.view.claudeTerminal';
export const CLAUDE_TERMINAL_VIEW_ID = 'workbench.view.claudeTerminal.view';

/**
 * The command the Claude Code terminal runs when its session starts. `${pluginDir}`
 * stands for Dim's built-in plugin folder (skills and hooks), quoted for the shell.
 */
const CLAUDE_TERMINAL_START_COMMAND_SETTING = 'dim.startCommand';
const CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE = '${pluginDir}';
const CLAUDE_TERMINAL_DEFAULT_START_COMMAND = `claude --plugin-dir ${CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE}`;

/** Resets {@link CLAUDE_TERMINAL_START_COMMAND_SETTING} to its default; linked from the setting's description. */
const CLAUDE_TERMINAL_RESET_START_COMMAND_ID = 'dim.resetStartCommand';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dim',
	title: localize('dimConfigurationTitle', "Dim"),
	type: 'object',
	properties: {
		[CLAUDE_TERMINAL_START_COMMAND_SETTING]: {
			type: 'string',
			default: CLAUDE_TERMINAL_DEFAULT_START_COMMAND,
			editPresentation: EditPresentationTypes.Multiline,
			// Runs in a shell, so only the user may set it, never a workspace.
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('dim.startCommand', "The command the Claude Code terminal runs to start its session. `{0}` is replaced with the folder of Dim's built-in skills and hooks; leave `--plugin-dir {0}` in to keep them. Each line runs in order. Takes effect the next time the session starts. [Reset to Default](command:{1})", CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE, CLAUDE_TERMINAL_RESET_START_COMMAND_ID),
		},
	},
});

CommandsRegistry.registerCommand(CLAUDE_TERMINAL_RESET_START_COMMAND_ID, accessor =>
	accessor.get(IConfigurationService).updateValue(CLAUDE_TERMINAL_START_COMMAND_SETTING, undefined, ConfigurationTarget.USER));

/**
 * Builds the shell command that starts the Claude session from the user's start command,
 * filling in `${pluginDir}` with the quoted plugin folder. Without a plugin folder the
 * `--plugin-dir ${pluginDir}` argument is dropped, so the command still runs.
 *
 * @param startCommand The configured start command.
 * @param pluginRoot Dim's built-in plugin folder, if it could be written.
 */
function resolveStartCommand(startCommand: string, pluginRoot: URI | undefined): string {
	if (!pluginRoot) {
		return startCommand.split(` --plugin-dir ${CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE}`).join('').split(CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE).join('');
	}
	const quoted = `'${pluginRoot.fsPath.replace(/'/g, `'\\''`)}'`;
	return startCommand.split(CLAUDE_TERMINAL_PLUGIN_DIR_VARIABLE).join(quoted);
}

const claudeTerminalIcon = registerIcon('claude-terminal-view-icon', Codicon.terminal, localize('claudeTerminalViewIcon', 'View icon of the Claude Code terminal view.'));

/**
 * A secondary-side-bar view pane that hosts a single integrated terminal running the Claude Code
 * CLI. The terminal is created lazily on first render and reused across show/hide so there is only
 * one Claude session per window.
 */
class ClaudeTerminalViewPane extends ViewPane {

	private _terminalContainer: HTMLElement | undefined;
	private _instance: ITerminalInstance | undefined;
	private _creating = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._terminalContainer = container;
		container.classList.add('claude-terminal-view');
		this._ensureTerminal();
	}

	private async _ensureTerminal(): Promise<void> {
		const container = this._terminalContainer;
		if (!container) {
			return;
		}
		if (this._instance) {
			this._attach(this._instance, container);
			return;
		}
		if (this._creating) {
			return;
		}
		this._creating = true;
		try {
			const instance = await this._terminalService.createTerminal({
				config: {
					name: localize('claudeTerminal.name', "Claude Code"),
					hideFromUser: true,
				},
				location: TerminalLocation.Panel,
			});
			this._instance = instance;
			this._register(instance.onExit(() => {
				// The Claude session's shell ended; drop the instance so it is recreated next time
				// the view is shown or focused.
				if (this._instance === instance) {
					this._instance = undefined;
				}
			}));
			if (this._terminalContainer) {
				this._attach(instance, this._terminalContainer);
			}
			// Launch the Claude Code CLI inside the terminal, loading Dim's built-in
			// skills and agent hook via a bundled plugin so they apply automatically
			// in every workspace with no dependency on `~/.claude` or a project `.claude/`.
			const pluginRoot = await this._ensureBuiltinPlugin();
			const startCommand = this.configurationService.getValue<string>(CLAUDE_TERMINAL_START_COMMAND_SETTING)?.trim() || CLAUDE_TERMINAL_DEFAULT_START_COMMAND;
			await instance.sendText(resolveStartCommand(startCommand, pluginRoot), true);
		} finally {
			this._creating = false;
		}
	}

	/**
	 * Materialize the Dim built-in Claude Code plugin on disk and return its root.
	 *
	 * The Ctrl+Alt+I terminal runs the standalone `claude` CLI, which does not read
	 * Dim's SDK options or the `vs/sessions/skills` built-ins; it discovers skills
	 * and hooks from its own configuration. To ship Dim's built-in skill and agent
	 * hook to that CLI for every build and every workspace — with no dependency on
	 * `~/.claude` or a project `.claude/` — we assemble a Claude Code plugin from the
	 * files baked into the build and launch `claude --plugin-dir <root>`.
	 *
	 * The plugin is written under the user data home (a stable path so any one-time
	 * plugin trust state persists) and is rebuilt on each launch so it tracks the
	 * bundled sources. `--plugin-dir` requires a `.claude-plugin/` folder; the build
	 * never copies dot-directories into `out/`, so the layout is generated here
	 * rather than shipped directly. Returns `undefined` if assembly fails, in which
	 * case the caller launches the CLI without the plugin.
	 */
	private async _ensureBuiltinPlugin(): Promise<URI | undefined> {
		try {
			const root = joinPath(this._environmentService.userRoamingDataHome, 'claudeTerminal', 'builtinPlugin');
			const manifestDir = joinPath(root, '.claude-plugin');
			const hooksDir = joinPath(root, 'hooks');
			await this._fileService.createFolder(manifestDir);
			await this._fileService.createFolder(hooksDir);

			const manifest = {
				name: 'dim-builtin',
				description: 'Dim built-in skills and hooks.',
				version: '0.0.0',
				skills: ['./skills/']
			};
			// Per-file `.dim` change records go to the open folder's `.dim` records
			// folder, matching where Dim's native agent sessions write them. Omitted
			// when no folder is open.
			const workspaceFolder = this._contextService.getWorkspace().folders.at(0)?.uri;
			const dimStorageDir = workspaceFolder ? dimHookStorageDir(workspaceFolder).fsPath : undefined;
			const hookCommand = dimStorageDir
				? `DIM_DIM_DIR="${dimStorageDir}" sh "\${CLAUDE_PLUGIN_ROOT}/hooks/updateDimHook.sh"`
				: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/updateDimHook.sh"';
			// DISABLED (Dim): the Stop hook is off for now because each run can spend a
			// Claude Haiku call per changed file; diagrams are still generated on file
			// open. The scripts are still copied below, so set this to `true` to re-enable.
			const stopHookEnabled = false;
			const hooks = {
				description: 'Dim built-in hooks',
				hooks: stopHookEnabled ? {
					// Fire once when the agent finishes its turn (end of its response),
					// rather than before every tool call.
					Stop: [{
						matcher: '',
						hooks: [{ type: 'command', command: hookCommand }]
					}]
				} : {}
			};
			await this._fileService.writeFile(joinPath(manifestDir, 'plugin.json'), VSBuffer.fromString(JSON.stringify(manifest, null, '\t')));
			await this._fileService.writeFile(joinPath(hooksDir, 'hooks.json'), VSBuffer.fromString(JSON.stringify(hooks, null, '\t')));

			// Copy the bundled hook script and its per-file diagram generator straight from
			// the build output so the plugin and Dim's native sessions share a single source
			// of truth. updateDimHook.sh resolves the generator relative to itself, so both
			// must land in the same hooks folder.
			const hookSource = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/updateDimHook.sh');
			const generatorSource = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/generateDimDiagram.sh');
			await this._fileService.writeFile(joinPath(hooksDir, 'updateDimHook.sh'), (await this._fileService.readFile(hookSource)).value);
			await this._fileService.writeFile(joinPath(hooksDir, 'generateDimDiagram.sh'), (await this._fileService.readFile(generatorSource)).value);

			// Copy each terminal skill's markdown files whole. For diagram-writing that is the
			// general SKILL.md (which holds the method and the catalog of kinds the generator
			// reads) plus every per-kind diagram skill (one markdown file per kind). The
			// generator resolves these from `../skills/diagram-writing/` relative to its hooks
			// folder and injects the matching kind's instructions into its prompt.
			for (const skillName of ['diagram-writing', 'open-files', 'big-picture']) {
				const skillDir = joinPath(root, 'skills', skillName);
				await this._fileService.createFolder(skillDir);
				const skillEntries = await this._fileService.resolve(FileAccess.asFileUri(`vs/sessions/skills/${skillName}`));
				for (const child of skillEntries.children ?? []) {
					if (!child.isDirectory && child.name.endsWith('.md')) {
						await this._fileService.writeFile(joinPath(skillDir, child.name), (await this._fileService.readFile(child.resource)).value);
					}
				}
			}

			return root;
		} catch (err) {
			this._logService.error('[ClaudeTerminal] Failed to assemble the Dim built-in Claude plugin', err);
			return undefined;
		}
	}

	private _attach(instance: ITerminalInstance, container: HTMLElement): void {
		instance.attachToElement(container);
		instance.setVisible(true);
		instance.layout({ width: container.offsetWidth, height: container.offsetHeight });
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._instance?.layout({ width, height });
	}

	override focus(): void {
		super.focus();
		// Recreate the session if it exited while hidden, then focus it.
		this._ensureTerminal();
		this._instance?.focus();
	}

	override dispose(): void {
		this._instance?.dispose();
		this._instance = undefined;
		super.dispose();
	}
}

const claudeTerminalViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CLAUDE_TERMINAL_VIEW_CONTAINER_ID,
	title: localize2('claudeTerminal.viewContainer.label', "Claude Code"),
	icon: claudeTerminalIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAUDE_TERMINAL_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CLAUDE_TERMINAL_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

const claudeTerminalViewDescriptor: IViewDescriptor = {
	id: CLAUDE_TERMINAL_VIEW_ID,
	containerIcon: claudeTerminalViewContainer.icon,
	containerTitle: claudeTerminalViewContainer.title.value,
	singleViewPaneContainerTitle: claudeTerminalViewContainer.title.value,
	name: localize2('claudeTerminal.view.label', "Claude Code"),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(ClaudeTerminalViewPane),
	openCommandActionDescriptor: {
		id: CLAUDE_TERMINAL_VIEW_CONTAINER_ID,
		title: claudeTerminalViewContainer.title,
		mnemonicTitle: localize({ key: 'miToggleClaudeTerminal', comment: ['&& denotes a mnemonic'] }, "&&Claude Code"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
			mac: {
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI
			}
		},
		order: 1
	},
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([claudeTerminalViewDescriptor], claudeTerminalViewContainer);

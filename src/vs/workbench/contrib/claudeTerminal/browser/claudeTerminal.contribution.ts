/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
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

const CLAUDE_TERMINAL_COMMAND = 'claude';

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
			// Launch the Claude Code CLI inside the terminal.
			await instance.sendText(CLAUDE_TERMINAL_COMMAND, true);
		} finally {
			this._creating = false;
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

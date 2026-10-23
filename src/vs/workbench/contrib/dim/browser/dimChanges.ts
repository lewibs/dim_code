/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { FileAccess } from '../../../../base/common/network.js';
import { extUri, joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { DIM_EDITOR_VIEW_TYPE, dimBigPictureDir } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISCMResourceGroup } from '../../scm/common/scm.js';
import { getHeadlessClaudeStartCommand } from '../../claudeTerminal/common/claudeStartCommand.js';

/**
 * The record holding the big-picture diagram of every change waiting for review, in a
 * workspace folder's big-picture folder. Written by `generateDimChanges.sh` and cleared on
 * commit by `dimDiff.ts` in the mermaid extension; keep the three in sync.
 */
const CHANGES_RECORD_NAME = 'changes.dim';

/**
 * The bundled changes generator. It takes the same arguments as the per-file generator,
 * so the extension host spawns it through the same command.
 */
const DIM_CHANGES_GENERATOR_URI = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/generateDimChanges.sh');

/** Duplicated from `dim.contribution`; see `GENERATE_RECORD_COMMAND` there. */
const GENERATE_RECORD_COMMAND = '_dim.generateRecord';

/**
 * Opens the diagram of all the changes waiting for review, from the inline actions of the
 * Source Control view's "Changes" group. An existing diagram opens at once and is brought
 * up to date in the background (the viewer redraws when its record changes); without one,
 * it is drawn first.
 */
class OpenDimChangesAction extends Action2 {

	static readonly ID = 'dim.openChangesDiagram';

	constructor() {
		super({
			id: OpenDimChangesAction.ID,
			title: localize2('dimOpenChangesDiagram', "Open Changes Diagram"),
			category: localize2('dimCategory', "Dim"),
			icon: Codicon.typeHierarchy,
			f1: true,
			menu: {
				id: MenuId.SCMResourceGroupContext,
				group: 'inline',
				order: -1,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals('scmResourceGroup', 'workingTree')),
			},
		});
	}

	override async run(accessor: ServicesAccessor, group?: ISCMResourceGroup): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const configurationService = accessor.get(IConfigurationService);

		// The repository's workspace folder, or the first one when run from the palette.
		const rootUri = group?.provider.rootUri;
		const folders = contextService.getWorkspace().folders;
		const folder = (rootUri && folders.find(candidate => extUri.isEqualOrParent(rootUri, candidate.uri))) ?? folders[0];
		if (!folder) {
			return;
		}
		const recordUri = joinPath(dimBigPictureDir(folder.uri), CHANGES_RECORD_NAME);
		const open = () => editorService.openEditor({ resource: recordUri, options: { override: DIM_EDITOR_VIEW_TYPE, pinned: true } });

		const exists = await fileService.exists(recordUri);
		if (exists) {
			await open();
		}
		// The generator shows its progress in the "Updating diagrams" status bar entry (see dimUpdatingStatus.ts)
		// and, reported under the record the viewer is keyed by, over the open diagram itself.
		await commandService.executeCommand(GENERATE_RECORD_COMMAND, {
			scriptUri: DIM_CHANGES_GENERATOR_URI.toString(),
			sourceUri: folder.uri.toString(),
			recordUri: recordUri.toString(),
			relPath: '',
			statusUri: recordUri.toString(),
			startCommand: getHeadlessClaudeStartCommand(configurationService),
		});
		if (exists) {
			return;
		}
		if (await fileService.exists(recordUri)) {
			await open();
		} else {
			notificationService.warn(localize('dimChangesFailed', "The changes diagram could not be drawn. Check that the Claude CLI (claude) is installed and signed in."));
		}
	}
}

registerAction2(OpenDimChangesAction);

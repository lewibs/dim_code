/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { DIM_EDITOR_VIEW_TYPE } from '../../../../platform/agentHost/common/dimHookStorage.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const IDimDiagramViewService = createDecorator<IDimDiagramViewService>('dimDiagramViewService');

/**
 * A Dim source file's text editor and its diagram viewer are distinct editor inputs for
 * the same resource, so opening the file by default while a diagram is showing would add a
 * second tab for the same file. Given the editor about to open and the editors already in
 * the target group, returns the diagram viewer already open for that resource — which the
 * caller should reveal instead of opening `target` — or `undefined` when there is none.
 *
 * Kept a plain function (not a service method) so the editor service can call it without a
 * dependency cycle: the Dim view service itself depends on the editor service.
 *
 * @param target The editor about to be opened.
 * @param groupEditors The editors already open in the target group.
 * @param isEqualResource Resource equality honouring the platform's path casing.
 */
export function findReusableDimEditor(target: EditorInput, groupEditors: readonly EditorInput[], isEqualResource: (a: URI | undefined, b: URI | undefined) => boolean): EditorInput | undefined {
	const resource = target.resource;
	// Only redirect a default (text) open, and only onto an already-open diagram viewer for
	// the same resource — the one case that otherwise duplicates the tab. Diagram opens go
	// through `replaceEditors`, which swaps in place.
	if (!resource || target.editorId !== DEFAULT_EDITOR_ASSOCIATION.id) {
		return undefined;
	}
	return groupEditors.find(editor => editor !== target && editor.editorId === DIM_EDITOR_VIEW_TYPE && isEqualResource(editor.resource, resource));
}

/**
 * One switchable Dim view for a source file: the raw source, or one of the diagrams
 * its companion `.dim` record holds. Surfaced in the breadcrumb editor-type picker
 * the same way Markdown offers its text/preview pair.
 */
export interface IDimDiagramViewOption {
	/** Stable id of the view: a `DimDiagramType` tag, `raw`, or `readme` (the overview). */
	readonly id: string;
	/** Localized label shown in the picker (e.g. "Structure", "Raw"). */
	readonly label: string;
	/** Id of the command that switches the active editor to this view. */
	readonly commandId: string;
	/** Whether this view is the one currently shown. */
	readonly checked: boolean;
}

/**
 * Describes the Dim views (raw source plus each diagram a `.dim` record holds) that a
 * source file can be switched between, so UI surfaces such as the breadcrumb
 * editor-type picker can offer them like Markdown's text/preview pair. Implemented by
 * the Dim contribution, which owns the record resolution and the view-switch commands.
 */
export interface IDimDiagramViewService {
	readonly _serviceBrand: undefined;

	/** Fires when the views available for the active editor may have changed. */
	readonly onDidChangeViewOptions: Event<void>;

	/**
	 * The Dim view options for an editor — the raw source plus each diagram its `.dim`
	 * record holds, with the current one checked — or `undefined` when the editor has no
	 * Dim record to toggle between (so callers fall back to their default behaviour).
	 *
	 * @param editor The editor to describe (typically the active editor).
	 */
	getViewOptions(editor: EditorInput): readonly IDimDiagramViewOption[] | undefined;
}

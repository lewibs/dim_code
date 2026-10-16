/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPaneSelectionCompareResult, IEditorPaneSelection } from '../../../common/editor.js';

/**
 * The view state a custom editor is opened on, carried in {@link IEditorOptions.viewState}.
 * Some custom editors show one resource in several ways (Dim shows a file's README or
 * one of its diagrams); the view names which one.
 */
interface ICustomEditorViewState {
	readonly customEditorView: string;
}

/**
 * Editor options that open a custom editor on the given view.
 */
export function customEditorViewOptions(view: string): IEditorOptions {
	const viewState: ICustomEditorViewState = { customEditorView: view };
	return { viewState };
}

/**
 * The view that editor options ask a custom editor to show, if any (see
 * {@link customEditorViewOptions}).
 */
export function customEditorViewFromOptions(options: IEditorOptions | undefined): string | undefined {
	const viewState = options?.viewState as Partial<ICustomEditorViewState> | undefined;
	return typeof viewState?.customEditorView === 'string' ? viewState.customEditorView : undefined;
}

/**
 * The selection of a custom editor that shows one of several views. Navigation history
 * records it, so going back or forward reopens the editor on the view it was left on.
 */
export class CustomEditorViewSelection implements IEditorPaneSelection {

	constructor(readonly view: string) { }

	compare(other: IEditorPaneSelection): EditorPaneSelectionCompareResult {
		return other instanceof CustomEditorViewSelection && other.view === this.view
			? EditorPaneSelectionCompareResult.IDENTICAL
			: EditorPaneSelectionCompareResult.DIFFERENT;
	}

	restore(options: IEditorOptions): IEditorOptions {
		return { ...options, ...customEditorViewOptions(this.view) };
	}

	log(): string {
		return `view: ${this.view}`;
	}
}

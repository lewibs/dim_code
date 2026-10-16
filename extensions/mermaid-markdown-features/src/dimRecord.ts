/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One diagram parsed from a `.dim` record: the mermaid source to render and a
 * short label for the viewer's toggle button.
 *
 * This mirrors `IDimDiagram`, `parseDimRecord` and `parseDimReadme` in
 * `src/vs/platform/agentHost/common/dimHookStorage.ts`; the extension cannot
 * import platform sources, so the small JSON shape is duplicated here. Keep the
 * two in sync.
 */
export interface IDimDiagramView {
	readonly type: string;
	readonly label: string;
	readonly mermaid: string;
}

const fallbackLabel = 'Diagram';

function labelForType(type: string): string {
	switch (type) {
		case 'classDiagram': return 'Structure';
		case 'sequenceDiagram': return 'Behavior';
		case 'flowchart': return 'Logic';
		case 'stateDiagram': return 'States';
		case 'erDiagram': return 'Data';
		default: return fallbackLabel;
	}
}

function inferType(mermaid: string): string {
	const head = mermaid.trimStart().toLowerCase();
	if (head.startsWith('classdiagram')) { return 'classDiagram'; }
	if (head.startsWith('sequencediagram')) { return 'sequenceDiagram'; }
	if (head.startsWith('statediagram')) { return 'stateDiagram'; }
	if (head.startsWith('erdiagram')) { return 'erDiagram'; }
	return 'flowchart';
}

/**
 * Parses the contents of a `.dim` file into its list of diagrams. Accepts both the
 * JSON record container (`{ version, diagrams: [...] }`) and a legacy record whose
 * whole content is a single block of raw mermaid source, so older records keep
 * rendering.
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimRecord(content: string): IDimDiagramView[] {
	const trimmed = content.trimStart();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(content) as { diagrams?: Array<{ type?: string; label?: string; mermaid?: string }> };
			if (parsed && Array.isArray(parsed.diagrams)) {
				// A valid JSON record: its diagrams are authoritative, even when empty (a
				// seeded or overview-only record has none). Only a non-JSON legacy record
				// falls through to being treated as a single block of raw mermaid below.
				return parsed.diagrams
					.filter((d): d is { type?: string; label?: string; mermaid: string } => !!d && typeof d.mermaid === 'string')
					.map(d => {
						const type = d.type ?? inferType(d.mermaid);
						return { type, label: d.label || labelForType(type), mermaid: d.mermaid };
					});
			}
		} catch {
			// Not valid JSON; fall through and treat the whole file as raw mermaid.
		}
	}
	const type = inferType(content);
	return [{ type, label: labelForType(type), mermaid: content }];
}

/**
 * Extracts the `readme` overview stored in a `.dim` record's JSON container, or
 * `undefined` when the record has none yet (a freshly seeded or legacy record, or
 * one whose generation has not produced an overview). Lets the viewer show the
 * overview in its always-available "README" view.
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimReadme(content: string): string | undefined {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(content) as { readme?: unknown };
		return typeof parsed.readme === 'string' && parsed.readme.length > 0 ? parsed.readme : undefined;
	} catch {
		return undefined;
	}
}

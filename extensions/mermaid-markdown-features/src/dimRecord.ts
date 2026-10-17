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
	/** What each clickable element of the diagram stands for in the code. */
	readonly links: readonly IDimLink[];
	/** The elements the file's changes waiting for review touched; empty when there are none. */
	readonly changes: readonly IDimChange[];
}

/** How a diagram element changed: see "Showing changes" in the `diagram-writing` skill. */
export type DimChangeKind = 'added' | 'changed' | 'removed';

const dimChangeKinds: readonly DimChangeKind[] = ['added', 'changed', 'removed'];

/**
 * One entry of a diagram's `changes` list, written by the generator when the file has
 * changes since its diff base: an element as the diagram draws it, named like a link's
 * `label`, and how it changed. The viewer colors the element to match.
 */
export interface IDimChange {
	readonly label: string;
	readonly change: DimChangeKind;
}

/** Keeps the well-formed entries of a diagram's raw `changes` value. */
function parseChanges(raw: unknown): IDimChange[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return (raw as Array<{ label?: unknown; change?: unknown } | null>)
		.filter((entry): entry is IDimChange => !!entry && typeof entry.label === 'string' && entry.label.trim().length > 0 && dimChangeKinds.includes(entry.change as DimChangeKind))
		.map(entry => ({ label: entry.label.trim(), change: entry.change }));
}

/**
 * The `diff` stamp of a record drawn while its file differed from the diff base: what the
 * changes are measured against (a commit for `base`, or the staged blob, `new` for an
 * untracked file, for `pending`, the changes waiting for review), and whether the file did
 * not exist there.
 */
export interface IDimDiff {
	readonly base: string;
	readonly isNew: boolean;
}

/**
 * Extracts a record's `diff` stamp, or `undefined` when the record was drawn from a file
 * with no changes (or is legacy or unreadable).
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimDiff(content: string): IDimDiff | undefined {
	if (!content.trimStart().startsWith('{')) {
		return undefined;
	}
	try {
		const diff = (JSON.parse(content) as { diff?: { base?: unknown; pending?: unknown; new?: unknown } }).diff;
		const base = diff?.base ?? diff?.pending;
		return diff && typeof base === 'string' && base.length > 0 ? { base, isNew: diff.new === true } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The kind of code a diagram element stands for: a class (or interface, type, enum), a
 * function or method, an attribute (field, property or class parameter), or a whole
 * file. The first three are also the kinds of focused view (see `dimNavigate.ts`).
 */
export type DimLinkKind = 'class' | 'function' | 'attribute' | 'file';

const dimLinkKinds: readonly DimLinkKind[] = ['class', 'function', 'attribute', 'file'];

/**
 * A view of the Dim viewer a link can open on: `raw` (the file in the text editor), the
 * `readme` overview, or one of the record's diagrams.
 */
export type DimLinkView = 'raw' | 'readme' | 'classDiagram' | 'sequenceDiagram' | 'flowchart' | 'stateDiagram' | 'erDiagram';

const dimLinkViews: readonly DimLinkView[] = ['raw', 'readme', 'classDiagram', 'sequenceDiagram', 'flowchart', 'stateDiagram', 'erDiagram'];

/** A 1-based line number, or `undefined` when the value is not one. */
function parseLine(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined;
}

/**
 * One entry of a diagram's `links` list, written by the generator: an element as the
 * diagram draws it (`label`) and the code it stands for. See "Making every element
 * clickable" in the `diagram-writing` skill.
 */
export interface IDimLink {
	/** The element as drawn: a box name, `Box.member`, a participant or a message's call. */
	readonly label: string;
	/** The code identifier, qualified by its owner for a member (`Class.member`). */
	readonly symbol: string;
	readonly kind: DimLinkKind;
	/** Workspace-relative path of the defining file, when known. */
	readonly file?: string;
	/** The view to open on, instead of the one the link's kind opens on. */
	readonly view?: DimLinkView;
	/**
	 * A 1-based line in the defining file. A link with a line opens the file raw, with
	 * that line (through {@link endLine}) selected.
	 */
	readonly line?: number;
	/** The last line of the range starting at {@link line}; just that line when omitted. */
	readonly endLine?: number;
	/** One sentence on what the element does, shown when the pointer rests on it. */
	readonly detail?: string;
}

/** Keeps the well-formed entries of a diagram's raw `links` value. */
function parseLinks(raw: unknown): IDimLink[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const links: IDimLink[] = [];
	for (const entry of raw as Array<Partial<Record<keyof IDimLink, unknown>> | null>) {
		if (entry && typeof entry.label === 'string' && typeof entry.symbol === 'string' && dimLinkKinds.includes(entry.kind as DimLinkKind)) {
			const line = parseLine(entry.line);
			const endLine = parseLine(entry.endLine);
			links.push({
				label: entry.label,
				symbol: entry.symbol,
				kind: entry.kind as DimLinkKind,
				file: typeof entry.file === 'string' && entry.file.length > 0 ? entry.file : undefined,
				view: dimLinkViews.includes(entry.view as DimLinkView) ? entry.view as DimLinkView : undefined,
				line,
				endLine: line !== undefined && endLine !== undefined && endLine >= line ? endLine : undefined,
				detail: typeof entry.detail === 'string' && entry.detail.trim().length > 0 ? entry.detail.trim() : undefined,
			});
		}
	}
	return links;
}

const fallbackLabel = 'Diagram';

/** The catalog's diagram types. Mirrors `dimDiagramTypes` in `dimDiagramTypes.ts`. */
const knownTypes: readonly string[] = ['classDiagram', 'sequenceDiagram', 'flowchart', 'stateDiagram', 'erDiagram'];

function labelForType(type: string): string {
	switch (type) {
		case 'classDiagram': return 'Structure';
		case 'sequenceDiagram': return 'Sequence';
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
			const parsed = JSON.parse(content) as { diagrams?: Array<{ type?: string; label?: string; mermaid?: string; links?: unknown; changes?: unknown }> };
			if (parsed && Array.isArray(parsed.diagrams)) {
				// A valid JSON record: its diagrams are authoritative, even when empty (a
				// seeded or overview-only record has none). Only a non-JSON legacy record
				// falls through to being treated as a single block of raw mermaid below.
				return parsed.diagrams
					.filter((d): d is { type?: string; label?: string; mermaid: string; links?: unknown; changes?: unknown } => !!d && typeof d.mermaid === 'string')
					.map(d => {
						// A type outside the catalog (e.g. `stateDiagram-v2`, the mermaid keyword
						// rather than the catalog's) is read from the diagram's own keyword.
						const type = d.type && knownTypes.includes(d.type) ? d.type : inferType(d.mermaid);
						return { type, label: d.label || labelForType(type), mermaid: d.mermaid, links: parseLinks(d.links), changes: parseChanges(d.changes) };
					});
			}
		} catch {
			// Not valid JSON; fall through and treat the whole file as raw mermaid.
		}
	}
	const type = inferType(content);
	return [{ type, label: labelForType(type), mermaid: content, links: [], changes: [] }];
}

/**
 * One test of a test file, listed in the README's tests table. Mirrors `IDimTestCase`
 * in `src/vs/platform/agentHost/common/dimHookStorage.ts`; keep the two in sync.
 */
export interface IDimTestCase {
	/** The enclosing suite (`suite`/`describe`) name, when the test is in one. */
	readonly suite?: string;
	readonly name: string;
	/** What behavior the test checks, in plain words. */
	readonly checks: string;
	/** The input or setup the test drives the code with. */
	readonly input: string;
	/** The result the test asserts. */
	readonly expected: string;
	/** What the test replaces with a mock, stub, spy or fake; empty when it runs real code. */
	readonly mocks: readonly string[];
	/** How the file's changes waiting for review touched the test; unset when they did not. */
	readonly change?: DimChangeKind;
}

/**
 * Extracts the `tests` table stored in a test file's `.dim` record, or `undefined`
 * when the record has none (it is not a test file, or is legacy or unreadable).
 * Entries without a name are dropped; missing text fields read as empty.
 *
 * @param content The raw text of the `.dim` file.
 */
export function parseDimTests(content: string): IDimTestCase[] | undefined {
	if (!content.trimStart().startsWith('{')) {
		return undefined;
	}
	let parsed: { tests?: unknown };
	try {
		parsed = JSON.parse(content) as { tests?: unknown };
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed.tests)) {
		return undefined;
	}
	const text = (value: unknown) => typeof value === 'string' ? value : '';
	const tests: IDimTestCase[] = [];
	for (const entry of parsed.tests as Array<Record<string, unknown> | null>) {
		if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
			continue;
		}
		const mocks = Array.isArray(entry.mocks) ? entry.mocks.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
		tests.push({
			suite: typeof entry.suite === 'string' && entry.suite.length > 0 ? entry.suite : undefined,
			name: entry.name,
			checks: text(entry.checks),
			input: text(entry.input),
			expected: text(entry.expected),
			mocks,
			change: dimChangeKinds.includes(entry.change as DimChangeKind) ? entry.change as DimChangeKind : undefined,
		});
	}
	return tests;
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { dimDiagramLabel, dimDiagramTypes } from '../../common/dimDiagramTypes.js';

suite('dimDiagramCatalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// The catalog lives as a markdown table "| entity | diagram | keyword | label | skill |"
	// in the diagram-writing skill's SKILL.md (the single source of truth the generator
	// reads): keep the table rows (they start with "|") minus the --- divider, drop the
	// first (the header), and read the columns.
	function readCatalogRows(): readonly { keyword: string; label: string; skill: string }[] {
		const catalogPath = FileAccess.asFileUri('vs/sessions/skills/diagram-writing/SKILL.md').fsPath;
		return readFileSync(catalogPath, 'utf8')
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.startsWith('|') && !line.includes('---'))
			.slice(1) // the first table row is the header
			.map(line => {
				const cells = line.split('|').map(cell => cell.trim());
				// cells: ['', entity, diagram, keyword, label, skill, '']
				return { keyword: cells[3], label: cells[4], skill: cells[5] };
			});
	}

	test('the catalog data file and the DimDiagramType enum never drift', () => {
		// The catalog file (read at runtime by generateDimDiagram.sh) is the single source
		// of truth for which diagram kinds exist and which code entity each is for. The enum
		// is a projection of its Mermaid-keyword column; this asserts the two agree on both
		// keyword and order, so a kind can never be added to one without the other.
		const catalog = readCatalogRows().map(row => ({ keyword: row.keyword, label: row.label }));

		const fromEnum = dimDiagramTypes.map(type => ({ keyword: type as string, label: dimDiagramLabel(type) }));

		assert.deepStrictEqual(catalog, fromEnum);
	});

	test('every catalog row names a diagram-writing skill file that exists', () => {
		// The generator injects each kind's skill (named by the catalog's Skill column) into
		// the prompt. A row naming a missing skill file would silently fall back to no
		// per-kind instructions, so fail the build instead.
		const skillsDir = FileAccess.asFileUri('vs/sessions/skills/diagram-writing').fsPath;
		const missing = readCatalogRows()
			.map(row => row.skill)
			.filter(skill => !skill || !existsSync(`${skillsDir}/${skill}`));

		assert.deepStrictEqual(missing, []);
	});
});

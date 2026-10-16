/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { dimDiagramLabel, dimDiagramTypes } from '../../common/dimDiagramTypes.js';

suite('dimDiagramCatalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the catalog data file and the DimDiagramType enum never drift', () => {
		// The catalog file (read at runtime by generateDimDiagram.sh) is the single source
		// of truth for which diagram kinds exist and which code entity each is for. The enum
		// is a projection of its Mermaid-keyword column; this asserts the two agree on both
		// keyword and order, so a kind can never be added to one without the other.
		// The catalog is a markdown table "| entity | diagram | keyword | label |" embedded in
		// prose: keep the table rows (they start with "|") minus the --- divider, drop the
		// first (the header), and read the keyword and label columns.
		const catalogPath = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow/dimDiagramCatalog.md').fsPath;
		const catalog = readFileSync(catalogPath, 'utf8')
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.startsWith('|') && !line.includes('---'))
			.slice(1) // the first table row is the header
			.map(line => {
				const cells = line.split('|').map(cell => cell.trim());
				// cells: ['', entity, diagram, keyword, label, '']
				return { keyword: cells[3], label: cells[4] };
			});

		const fromEnum = dimDiagramTypes.map(type => ({ keyword: type as string, label: dimDiagramLabel(type) }));

		assert.deepStrictEqual(catalog, fromEnum);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

/** Lists the files under `dir`, as paths relative to it, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path, `${prefix}${name}/`) : [`${prefix}${name}`];
	}).sort();
}

(isWindows ? suite.skip : suite)('dimWorkflowScripts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const workflowDir = FileAccess.asFileUri('vs/platform/agentHost/node/claude/dimWorkflow').fsPath;
	let tmpRoot: string;

	setup(() => {
		tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dim-workflow-')));
	});

	teardown(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	test('the Stop hook generates changed files and removes records whose code is gone', () => {
		// The hook runs next to a stub generator that logs each job instead of asking Claude.
		const hooksDir = join(tmpRoot, 'hooks');
		const repo = join(tmpRoot, 'repo');
		const records = join(repo, '.dim');
		const log = join(tmpRoot, 'log');
		mkdirSync(hooksDir);
		mkdirSync(join(records, 'big_picture'), { recursive: true });
		copyFileSync(join(workflowDir, 'updateDimHook.sh'), join(hooksDir, 'updateDimHook.sh'));
		writeFileSync(join(hooksDir, 'generateDimDiagram.sh'), `echo "$3|$4|$5" >> '${log}'\n`);

		const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
		git('init', '-q');
		git('config', 'user.email', 'dim@example.com');
		git('config', 'user.name', 'Dim');
		writeFileSync(join(repo, 'a.ts'), 'class A { run() {} }\n');
		writeFileSync(join(repo, 'old name.ts'), 'x\n');
		writeFileSync(join(repo, 'keep.ts'), 'y\n');
		writeFileSync(join(repo, 'gone.ts'), 'z\n');
		git('add', '-A');
		git('commit', '-qm', 'init');

		writeFileSync(join(records, 'keep.ts.dim'), '{}');
		writeFileSync(join(records, 'gone.ts.dim'), '{}');
		writeFileSync(join(records, 'a.ts#A.run.dim'), '{"focus": {"kind": "function", "symbol": "A.run"}}');
		writeFileSync(join(records, 'a.ts#A.walk.dim'), '{"focus": {"kind": "function", "symbol": "A.walk"}}');
		writeFileSync(join(records, 'a.ts#A.old.dim'), '{}');
		writeFileSync(join(records, 'big_picture', 'fresh.dim'), '{"links": [{"file": "keep.ts"}]}');
		writeFileSync(join(records, 'big_picture', 'stale.dim'), '{"links": [{"file": "gone.ts"}]}');
		writeFileSync(join(records, 'big_picture', 'changes.dim'), '{"links": [{"file": "gone.ts"}]}');

		// An edit, a committed deletion, a rename of a path with a space and a new file.
		writeFileSync(join(repo, 'a.ts'), 'class A { run() { return 1; } }\n');
		git('rm', '-q', 'gone.ts');
		git('commit', '-qm', 'delete');
		git('mv', 'old name.ts', 'new name.ts');
		writeFileSync(join(repo, 'brand new.ts'), 'n\n');

		cp.execFileSync('sh', [join(hooksDir, 'updateDimHook.sh')], { cwd: repo, env: { ...process.env, DIM_DIM_DIR: records }, stdio: 'ignore' });

		assert.deepStrictEqual({
			generated: readFileSync(log, 'utf8').trim().split('\n').sort(),
			records: listFiles(records).filter(file => file.endsWith('.dim')),
		}, {
			generated: ['a.ts|function|A.run', 'a.ts||', 'brand new.ts||', 'new name.ts||'],
			records: ['a.ts#A.run.dim', 'big_picture/changes.dim', 'big_picture/fresh.dim', 'keep.ts.dim'],
		});
	});

	test('the reply check flags links to missing files and changes that name nothing drawn', () => {
		const mermaidDir = FileAccess.asFileUri('').fsPath + '/../extensions/mermaid-markdown-features/node_modules';
		writeFileSync(join(tmpRoot, 'real.ts'), '');
		const reply = JSON.stringify({
			diagrams: [{
				type: 'classDiagram',
				label: 'Structure',
				mermaid: 'classDiagram\n class Foo {\n +bar()\n }',
				links: [{ label: 'Foo', file: 'real.ts' }, { label: 'Foo.bar', file: 'missing.ts' }],
				changes: [{ label: 'Foo.bar', change: 'added' }, { label: 'Baz.qux', change: 'removed' }],
			}],
		});

		const result = cp.spawnSync(process.execPath, [join(workflowDir, 'validateDimDiagrams.js'), mermaidDir, tmpRoot], {
			input: reply,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			encoding: 'utf8',
		});

		assert.deepStrictEqual({ status: result.status, errors: result.stderr.trim().split('\n') }, {
			status: 1,
			errors: [
				'Structure (classDiagram): a link names the file "missing.ts", which does not exist. Give the workspace-relative path of the file that defines the symbol.',
				'Structure (classDiagram): its "changes" names "Baz.qux", which the diagram does not draw. Name each changed element exactly as the "label" of its link.',
			],
		});
	});
});

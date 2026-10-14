/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { dimHookRecordUri, dimHookStorageDir } from '../../common/dimHookStorage.js';

suite('dimHookStorage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dimHookRecordUri mirrors workspace-relative paths under the storage bucket', () => {
		const storageHome = URI.file('/home/u/.config/dim-dev/User/workspaceStorage');
		const folder = URI.file('/home/u/project');
		const dir = dimHookStorageDir(storageHome, folder);

		assert.deepStrictEqual({
			rootFile: dimHookRecordUri(storageHome, folder, URI.file('/home/u/project/foo.ts'))?.toString(),
			nestedFile: dimHookRecordUri(storageHome, folder, URI.file('/home/u/project/src/a/b.ts'))?.toString(),
			outsideFolder: dimHookRecordUri(storageHome, folder, URI.file('/home/u/other/x.ts')),
			folderItself: dimHookRecordUri(storageHome, folder, folder),
		}, {
			rootFile: joinPath(dir, 'foo.ts.dim').toString(),
			nestedFile: joinPath(dir, 'src/a/b.ts.dim').toString(),
			outsideFolder: undefined,
			folderItself: undefined,
		});
	});
});

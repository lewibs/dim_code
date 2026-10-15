/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { dimHookRecordUri, dimHookStorageDir, dimSourceFromRecordUri, parseDimRecord, seedDimRecord, serializeDimRecord, isDimCodeFile } from '../../common/dimHookStorage.js';
import { DimDiagramType } from '../../common/dimDiagramTypes.js';

suite('dimHookStorage', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const storageHome = URI.file('/home/u/.config/dim-dev/User/workspaceStorage');
	const folder = URI.file('/home/u/project');

	test('dimHookRecordUri mirrors workspace-relative paths under the storage bucket', () => {
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

	test('isDimCodeFile matches source code but not docs, data, config or extensionless files', () => {
		assert.deepStrictEqual({
			ts: isDimCodeFile(URI.file('/p/src/a.ts')),
			python: isDimCodeFile(URI.file('/p/main.py')),
			upperCase: isDimCodeFile(URI.file('/p/Main.JAVA')),
			markdown: isDimCodeFile(URI.file('/p/README.md')),
			json: isDimCodeFile(URI.file('/p/package.json')),
			text: isDimCodeFile(URI.file('/p/notes.txt')),
			dotfile: isDimCodeFile(URI.file('/p/.gitignore')),
			extensionless: isDimCodeFile(URI.file('/p/Makefile')),
		}, {
			ts: true,
			python: true,
			upperCase: true,
			markdown: false,
			json: false,
			text: false,
			dotfile: false,
			extensionless: false,
		});
	});

	test('dimSourceFromRecordUri reverses dimHookRecordUri and rejects non-records', () => {
		const rootFile = URI.file('/home/u/project/foo.ts');
		const nestedFile = URI.file('/home/u/project/src/a/b.ts');
		const rootRecord = dimHookRecordUri(storageHome, folder, rootFile)!;
		const nestedRecord = dimHookRecordUri(storageHome, folder, nestedFile)!;

		assert.deepStrictEqual({
			rootRoundTrip: dimSourceFromRecordUri(storageHome, [folder], rootRecord)?.toString(),
			nestedRoundTrip: dimSourceFromRecordUri(storageHome, [folder], nestedRecord)?.toString(),
			notARecord: dimSourceFromRecordUri(storageHome, [folder], rootFile),
			outsideStorage: dimSourceFromRecordUri(storageHome, [folder], URI.file('/home/u/project/foo.ts.dim')),
		}, {
			rootRoundTrip: rootFile.toString(),
			nestedRoundTrip: nestedFile.toString(),
			notARecord: undefined,
			outsideStorage: undefined,
		});
	});

	suite('seedDimRecord', () => {

		let fileService: IFileService;

		setup(() => {
			fileService = disposables.add(new FileService(new NullLogService()));
			disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		});

		test('creates a placeholder record for a source file, carrying its relative source path', async () => {
			const file = URI.file('/home/u/project/src/a.ts');
			const record = await seedDimRecord(fileService, storageHome, folder, file);
			const content = record && (await fileService.readFile(record)).value.toString();

			assert.deepStrictEqual({
				record: record?.toString(),
				hasDiagrams: content ? parseDimRecord(content).length > 0 : false,
			}, {
				record: dimHookRecordUri(storageHome, folder, file)!.toString(),
				hasDiagrams: true,
			});
		});

		test('leaves an existing record untouched', async () => {
			const file = URI.file('/home/u/project/src/a.ts');
			const record = dimHookRecordUri(storageHome, folder, file)!;
			const original = serializeDimRecord([{ type: DimDiagramType.Flowchart, label: 'Kept', mermaid: 'graph TD; A-->B' }], 'src/a.ts');
			await fileService.createFile(record, VSBuffer.fromString(original));

			const returned = await seedDimRecord(fileService, storageHome, folder, file);

			assert.deepStrictEqual({
				returned: returned?.toString(),
				content: (await fileService.readFile(record)).value.toString(),
			}, {
				returned: record.toString(),
				content: original,
			});
		});

		test('returns undefined without writing for files that get no record', async () => {
			const doc = URI.file('/home/u/project/README.md');
			const outside = URI.file('/home/u/other/x.ts');
			const aRecord = joinPath(dimHookStorageDir(storageHome, folder), 'foo.ts.dim');

			assert.deepStrictEqual({
				doc: await seedDimRecord(fileService, storageHome, folder, doc),
				outside: await seedDimRecord(fileService, storageHome, folder, outside),
				record: await seedDimRecord(fileService, storageHome, folder, aRecord),
				wroteNothing: await fileService.exists(dimHookStorageDir(storageHome, folder)),
			}, {
				doc: undefined,
				outside: undefined,
				record: undefined,
				wroteNothing: false,
			});
		});
	});
});

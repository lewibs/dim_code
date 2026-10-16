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
import { dimHookRecordUri, dimHookStorageDir, dimSourceFromRecordUri, seedDimRecord, serializeDimRecord, isDimCodeFile, syncDimRecordsGitignore } from '../../common/dimHookStorage.js';
import { DimDiagramType } from '../../common/dimDiagramTypes.js';

suite('dimHookStorage', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const folder = URI.file('/home/u/project');

	test('dimHookRecordUri mirrors workspace-relative paths under the workspace .dim folder', () => {
		const dir = dimHookStorageDir(folder);

		assert.deepStrictEqual({
			rootFile: dimHookRecordUri(folder, URI.file('/home/u/project/foo.ts'))?.toString(),
			nestedFile: dimHookRecordUri(folder, URI.file('/home/u/project/src/a/b.ts'))?.toString(),
			outsideFolder: dimHookRecordUri(folder, URI.file('/home/u/other/x.ts')),
			folderItself: dimHookRecordUri(folder, folder),
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
		const rootRecord = dimHookRecordUri(folder, rootFile)!;
		const nestedRecord = dimHookRecordUri(folder, nestedFile)!;

		assert.deepStrictEqual({
			rootRoundTrip: dimSourceFromRecordUri([folder], rootRecord)?.toString(),
			nestedRoundTrip: dimSourceFromRecordUri([folder], nestedRecord)?.toString(),
			notARecord: dimSourceFromRecordUri([folder], rootFile),
			outsideRecordsFolder: dimSourceFromRecordUri([folder], URI.file('/home/u/project/foo.ts.dim')),
		}, {
			rootRoundTrip: rootFile.toString(),
			nestedRoundTrip: nestedFile.toString(),
			notARecord: undefined,
			outsideRecordsFolder: undefined,
		});
	});

	suite('seedDimRecord', () => {

		let fileService: IFileService;

		setup(() => {
			fileService = disposables.add(new FileService(new NullLogService()));
			disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		});

		test('creates an empty record for a source file, carrying its relative source path', async () => {
			const file = URI.file('/home/u/project/src/a.ts');
			const record = await seedDimRecord(fileService, folder, file, true);
			const content = record && (await fileService.readFile(record)).value.toString();

			// No placeholder or default diagram is seeded: the file shows as raw source
			// until the generator writes a diagram chosen from its code.
			assert.deepStrictEqual({
				record: record?.toString(),
				content,
			}, {
				record: dimHookRecordUri(folder, file)!.toString(),
				content: serializeDimRecord([], 'src/a.ts'),
			});
		});

		test('leaves an existing record untouched', async () => {
			const file = URI.file('/home/u/project/src/a.ts');
			const record = dimHookRecordUri(folder, file)!;
			const original = serializeDimRecord([{ type: DimDiagramType.Flowchart, label: 'Kept', mermaid: 'graph TD; A-->B' }], 'src/a.ts');
			await fileService.createFile(record, VSBuffer.fromString(original));

			const returned = await seedDimRecord(fileService, folder, file, true);

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
			const aRecord = joinPath(dimHookStorageDir(folder), 'foo.ts.dim');

			assert.deepStrictEqual({
				doc: await seedDimRecord(fileService, folder, doc, true),
				outside: await seedDimRecord(fileService, folder, outside, true),
				record: await seedDimRecord(fileService, folder, aRecord, true),
				wroteNothing: await fileService.exists(dimHookStorageDir(folder)),
			}, {
				doc: undefined,
				outside: undefined,
				record: undefined,
				wroteNothing: false,
			});
		});

		test('keeps the records folder .gitignore in line with the setting', async () => {
			const gitignore = joinPath(dimHookStorageDir(folder), '.gitignore');
			await seedDimRecord(fileService, folder, URI.file('/home/u/project/src/a.ts'), true);
			const written = (await fileService.readFile(gitignore)).value.toString();
			const createdWhenIgnored = await fileService.exists(gitignore);

			await syncDimRecordsGitignore(fileService, folder, false);
			const removedWhenCommitted = !(await fileService.exists(gitignore));

			await seedDimRecord(fileService, folder, URI.file('/home/u/project/src/b.ts'), false);
			const notRecreatedBySeed = !(await fileService.exists(gitignore));

			await syncDimRecordsGitignore(fileService, folder, true);

			assert.deepStrictEqual({
				dir: dimHookStorageDir(folder).toString(),
				ignoresEverything: written.split('\n').includes('*'),
				createdWhenIgnored,
				removedWhenCommitted,
				notRecreatedBySeed,
				restoredWhenIgnoredAgain: await fileService.exists(gitignore),
			}, {
				dir: URI.file('/home/u/project/.dim').toString(),
				ignoresEverything: true,
				createdWhenIgnored: true,
				removedWhenCommitted: true,
				notRecreatedBySeed: true,
				restoredWhenIgnoredAgain: true,
			});
		});
	});
});

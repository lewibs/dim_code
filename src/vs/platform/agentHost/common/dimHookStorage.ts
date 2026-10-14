/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../base/common/hash.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Resolves the directory where the Dim `updateDimHook` agent hook writes its
 * per-file `.dim` change records for a given workspace folder.
 *
 * The records are kept out of the repository and under the user-data root at
 * `<workspaceStorageHome>/dim/<key>`, so a project folder is never polluted with
 * generated files. `<key>` is a stable, non-cryptographic hash of the folder's
 * URI rather than VS Code's own per-workspace storage id: that id salts in the
 * folder's filesystem `ctime`, which is only reachable inside the workbench, so
 * a parallel `dim/` bucket lets both the native agent session and the
 * standalone CLI terminal agree on the same location from different layers.
 *
 * @param workspaceStorageHome The `workspaceStorageHome` from the environment service.
 * @param workspaceFolder The opened workspace folder the records belong to.
 */
export function dimHookStorageDir(workspaceStorageHome: URI, workspaceFolder: URI): URI {
	const key = (stringHash(workspaceFolder.toString(), 0) >>> 0).toString(16);
	return joinPath(workspaceStorageHome, 'dim', key);
}

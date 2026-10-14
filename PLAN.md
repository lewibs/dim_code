# File System Storage Notes

Where Dim (this VS Code fork) stores project-related files, and how to persist our own per-project data.

## Product naming (from `product.json`)

| Field | Value | Used for |
|---|---|---|
| `nameLong` | `Dim` | User-data directory name |
| `applicationName` | `dim` | CLI binary name |
| `dataFolderName` | `.dim` | Extensions folder in `$HOME` |
| `serverDataFolderName` | `.dim-server` | Server-side data folder |

## Two places project state lives

### 1. Inside the project folder

- `.vscode/` — the only project data committed to the repo: `settings.json`, `launch.json`, `tasks.json`, `extensions.json`.

### 2. Per-workspace state in the user-data directory

The user-data root is the same for every project you open; each opened folder just gets its own hashed subfolder beneath it. It does **not** create a new config directory per project.

Platform roots:

- **Linux:** `~/.config/Dim/` (or `$XDG_CONFIG_HOME/Dim/`)
- **macOS:** `~/Library/Application Support/Dim/`
- **Windows:** `%APPDATA%\Dim\`

Project-scoped contents under that root:

```
~/.config/Dim/
└── User/
    └── workspaceStorage/
        ├── <hash-of-folderA>/
        │   ├── workspace.json   { "folder": "file:///home/you/projectA" }
        │   └── state.vscdb      per-workspace key/value state (SQLite)
        └── <hash-of-folderB>/
            ├── workspace.json   { "folder": "file:///home/you/projectB" }
            └── state.vscdb
```

- `<hash>` is an **MD5 of the folder's URI** (e.g. `file:///home/you/projectB`). Each distinct folder → distinct hash → its own subfolder.
- `workspace.json` records which folder/workspace a hash maps to.
- Multi-root / `.code-workspace` files are hashed by the workspace file's URI instead of a single folder.
- This state is **persistent** (survives restarts) and **not auto-cleaned** — stale entries accumulate even after a project folder is deleted.

Other (non-per-project) neighbors in the same root: `User/settings.json`, `User/keybindings.json`, `User/globalStorage/`, `Backups/` (hot-exit unsaved files), `User/History/` (timeline), `logs/`.

Extensions install to `$HOME` instead: `~/.dim/extensions/`.

## Storing our own per-project data

### Key/value → `IStorageService`

The hash is handled for us; never compute it.

```typescript
constructor(@IStorageService private readonly storageService: IStorageService) {}

// per-project (lands in this workspace's state.vscdb)
this.storageService.store('myKey', value, StorageScope.WORKSPACE, StorageTarget.MACHINE);

// shared across all projects
this.storageService.store('myKey', value, StorageScope.PROFILE, StorageTarget.MACHINE);

const value = this.storageService.get('myKey', StorageScope.WORKSPACE);
```

### Files (e.g. a per-project `.md`) → `IFileService`

The per-workspace folder is `workspaceStorageHome / <workspace.id>`, where `workspace.id` **is** the on-disk hash.

- `workspaceStorageHome` comes from `IWorkbenchEnvironmentService` (`environmentService.ts:119` → `joinPath(userRoamingDataHome, 'workspaceStorage')`).
- `workspace.id` comes from `IWorkspaceContextService.getWorkspace().id`.

```typescript
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

constructor(
    @IFileService private readonly fileService: IFileService,
    @IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
    @IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
) {}

private get notesUri() {
    const workspaceId = this.contextService.getWorkspace().id;   // the hash
    return joinPath(this.environmentService.workspaceStorageHome, workspaceId, 'notes.md');
}

async writeNotes(markdown: string): Promise<void> {
    await this.fileService.createFile(this.notesUri, VSBuffer.fromString(markdown), { overwrite: true });
}

async readNotes(): Promise<string | undefined> {
    try {
        const content = await this.fileService.readFile(this.notesUri);
        return content.value.toString();
    } catch {
        return undefined; // not created yet
    }
}
```

Result lands at `~/.config/Dim/User/workspaceStorage/<hash>/notes.md`, automatically scoped to the open project.

### Gotchas

- Use `IFileService`, not `node:fs` — it works in web/remote, resolves the scheme, and creates missing parent directories.
- A raw file dropped in `workspaceStorage` is **not** auto-cleaned (unlike `state.vscdb` keys); it persists until deleted.
- **Empty window:** with no folder/workspace open, `getWorkspace().id` is the empty-window id and the file goes into a bucket that may be recycled. Guard on `getWorkbenchState() !== WorkbenchState.EMPTY` if the feature only makes sense with a folder open.

---
name: open-files
description: Open files in the user's Dim editor window so they can follow along. Use whenever the user asks how something works, what a file does, which files handle a feature, or where some code lives — open the files you point them to (at the relevant line) without being asked.
---

# Opening files in Dim for the user

The user is reading code in Dim (a VS Code fork) next to you. Don't just tell them where code is: open it in their editor.

## When to open files

Open files automatically, without asking first, when the user:

- asks how a feature, flow or system works
- asks what a file, class or function does
- asks where something is implemented, defined, configured or tested
- asks which files are involved in something

Rules:

- Open the files your answer is about, ideally at the line where the relevant code starts (the function, class or config entry, not line 1).
- Open the most important file **last** so it ends up focused. Usually that's 1–3 files. Don't open every file you read while investigating.
- Only open files that exist. Use absolute paths.
- Do this after you've found the answer and before you write your reply. In the reply, say which files you opened, as `path:line` references.
- Don't open files for tasks where the user is only asking you to edit, run or build something, unless they ask.

## How to open a file

Run this in Bash. It finds a CLI that talks to the running Dim window and opens each `path[:line[:column]]` argument in the current window:

```bash
dim_open() {
	# Packaged Dim: the `dim` CLI forwards to the window that owns this terminal.
	if [ -n "$VSCODE_IPC_HOOK_CLI" ] && command -v dim >/dev/null 2>&1; then
		dim -r -g "$@"
		return
	fi
	# Dev build (./scripts/code.sh): run the build's own CLI. It forwards to the running instance over its main socket.
	local exe root
	exe=$(ps -eo args= | awk '$1 ~ /\/\.build\/electron\/(dim|Dim\.app\/Contents\/MacOS\/Dim)$/ { print $1; exit }')
	if [ -n "$exe" ]; then
		root=${exe%%/.build/electron/*}
		ELECTRON_RUN_AS_NODE=1 VSCODE_DEV=1 NODE_ENV=development "$exe" "$root/out/cli.js" -r -g "$@" >/dev/null 2>&1
		return
	fi
	echo "dim_open: no running Dim instance found" >&2
	return 1
}
dim_open /abs/path/to/helper.ts:12 /abs/path/to/main.ts:42
```

Notes:

- `-r` reuses the last active Dim window. `-g` accepts `file:line[:column]`.
- Always pass absolute paths. Relative paths may be resolved against the wrong directory.
- In the dev build, don't use `scripts/code-cli.sh`. It always passes the Dim repo folder (`.`) as well, and with `-r` that can replace the user's open workspace.
- If the command fails or finds no Dim instance, answer anyway with `path:line` references and mention in one line that the files couldn't be opened.

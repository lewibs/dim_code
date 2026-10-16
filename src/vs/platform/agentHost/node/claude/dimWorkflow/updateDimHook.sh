#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim built-in agent hook. Runs once when the agent finishes a turn (Stop) and,
# for every code file changed in the workspace since the last commit, (re)generates
# its companion "<file>.dim" diagram record. The diagram kind is chosen per file by
# generateDimDiagram.sh (the single generation step this hook shares with the
# editor's file-open path), not hard-coded here.
#
# Inputs (set by the caller):
#   cwd          - the workspace root, so git sees the project repository
#   DIM_DIM_DIR  - directory the ".dim" records are written under: the workspace's
#                  ".dim" records folder. Records mirror the repo-relative path of
#                  each changed file with a ".dim" suffix: src/foo.ts -> $DIM_DIM_DIR/src/foo.ts.dim

# The shared per-file generator sits next to this script (in the bundled build and
# in the materialized CLI-terminal plugin, both scripts live in the same folder).
generator="$(dirname "$0")/generateDimDiagram.sh"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "Not a git repository; skipping .dim update."
	exit 0
fi

if [ -z "$DIM_DIM_DIR" ]; then
	echo "DIM_DIM_DIR is not set; skipping .dim update."
	exit 0
fi

root=$(pwd)

# A new records folder ignores itself in git via its own ".gitignore", matching the
# default of the "dim.diagrams.gitignore" setting (which the editor then applies on
# its next start or setting change). Mirrors `syncDimRecordsGitignore` in
# dimHookStorage.ts; keep the two in sync.
if [ ! -d "$DIM_DIM_DIR" ]; then
	mkdir -p "$DIM_DIM_DIR"
	printf '# Dim diagram records. Turn off the "dim.diagrams.gitignore" setting to commit them with the code.\n*\n' > "$DIM_DIM_DIR/.gitignore"
fi

# `--untracked-files=all` lists each new file individually; without it git collapses
# a wholly-untracked directory to a single entry (e.g. "src/") and its files would
# never be recorded.
changed=$(git status --porcelain --untracked-files=all)
if [ -z "$changed" ]; then
	echo "No files changed since last commit; nothing to record."
	exit 0
fi

# git status --porcelain emits two status chars, a space, then the path. For a
# rename the path is "old -> new"; we record the new path. Other quoting cases
# (paths with unusual characters) are left to git's defaults. The loop only picks
# the files, one per line; they are generated afterwards, several at a time (see below).
files=$(echo "$changed" | while IFS= read -r line; do
	path=$(printf '%s' "$line" | cut -c4-)
	case "$path" in
		*" -> "*) path=${path##* -> } ;;
	esac

	# Never record the records themselves.
	case "$path" in
		*.dim) continue ;;
	esac

	# Only record source-code files; skip docs, data, config and extensionless
	# files. This list mirrors `dimCodeExtensions` in dimHookStorage.ts; keep the
	# two in sync.
	base=${path##*/}
	case "$base" in
		*.*) ext=$(printf '%s' "${base##*.}" | tr '[:upper:]' '[:lower:]') ;;
		*) ext="" ;;
	esac
	codeExtensions=" ts tsx mts cts js jsx mjs cjs py pyw pyi java kt kts scala groovy c h cc cpp cxx hpp hh hxx cs go rs rb php swift m mm sh bash zsh fish pl pm lua r dart ex exs erl hs fs fsx vb clj cljs sql vue svelte html htm css scss sass less "
	case "$codeExtensions" in
		*" $ext "*) ;;
		*) continue ;;
	esac

	printf '%s\n' "$path"
done)
if [ -z "$files" ]; then
	echo "No code files changed since last commit; nothing to record."
	exit 0
fi

# While this run lasts it keeps a status file, "$DIM_DIM_DIR/.updating/<pid>", that the
# editor watches to show its "Updating diagrams" pill: the first line is the number of
# files to check and each finished file appends a line. A status file left behind by a
# run that was killed is removed here. Mirrored by `dimUpdatingPill.ts`; keep the two in
# sync.
statusDir="$DIM_DIM_DIR/.updating"
mkdir -p "$statusDir"
for stale in "$statusDir"/*; do
	[ -f "$stale" ] || continue
	kill -0 "${stale##*/}" 2>/dev/null || rm -f "$stale"
done
status="$statusDir/$$"
printf '%s\n' "$files" | wc -l | tr -d ' ' > "$status"
trap 'rm -f "$status"' EXIT
trap 'exit 130' INT TERM HUP

# Delegate to the shared generator, which picks the diagrams for each file's code and
# (re)writes the record only when the source has changed. Each file takes Claude about
# a minute, so DIM_HOOK_JOBS (default 4) files are generated at once to have the records
# ready before the user opens them. Invoked via `sh` (as this hook itself is launched)
# so it runs even when the copied script, written without an executable bit, is not
# marked executable. Paths reach the inner shell as arguments, never as code.
printf '%s\n' "$files" | tr '\n' '\0' |
	xargs -0 -P "${DIM_HOOK_JOBS:-4}" -I{} sh -c 'sh "$1" "$2/$5" "$3/$5.dim" "$5"; echo >> "$4"' sh "$generator" "$root" "$DIM_DIM_DIR" "$status" {}

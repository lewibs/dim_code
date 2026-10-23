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

# Records outlive their code: a file deleted outside an agent turn, or a deletion that is
# already committed, leaves its records behind. Remove each record whose source file is
# gone, and each big-picture record that links to a file that is gone, as it describes code
# that no longer exists (asking its question again draws it anew). The changes view is
# left alone: it is redrawn by its own generator, and it shows deleted files on purpose.
find "$DIM_DIM_DIR" -type f -name '*.dim' | while IFS= read -r record; do
	rel=${record#"$DIM_DIM_DIR/"}
	case "$rel" in
		big_picture/changes.dim) ;;
		big_picture/*)
			grep -o '"file"[[:space:]]*:[[:space:]]*"[^"]*"' "$record" \
				| sed 's/.*"\([^"]*\)"$/\1/' | sort -u \
				| while IFS= read -r linked; do
					case "$linked" in
						/*) [ -e "$linked" ] || echo "$linked" ;;
						*) [ -e "$root/$linked" ] || echo "$linked" ;;
					esac
				done | grep -q . && rm -f "$record"
			;;
		*)
			source=${rel%.dim}
			source=${source%%#*}
			[ -e "$root/$source" ] || rm -f "$record"
			;;
	esac
done

# `--untracked-files=all` lists each new file individually; without it git collapses
# a wholly-untracked directory to a single entry (e.g. "src/") and its files would
# never be recorded. `-z` gives each path as it is, rather than quoted when it holds
# spaces or unusual characters; the NULs become line breaks for the loop below.
changed=$(git status --porcelain -z --untracked-files=all | tr '\0' '\n')
if [ -z "$changed" ]; then
	echo "No files changed since last commit; nothing to record."
	exit 0
fi

# Each entry is two status chars, a space, then the path. A rename or copy ("R" or "C")
# gives the new path, followed by the old path as an entry of its own, which is skipped.
# The loop only picks the files, one per line; they are generated afterwards, several at
# a time (see below).
files=$(printf '%s\n' "$changed" | {
	skipOld=0
	while IFS= read -r line; do
		if [ "$skipOld" = 1 ]; then
			skipOld=0
			continue
		fi
		path=${line#???}
		case "$line" in
			R* | C*) skipOld=1 ;;
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
	done
})
if [ -z "$files" ]; then
	echo "No code files changed since last commit; nothing to record."
	exit 0
fi

# Turn the changed files into generation jobs, one per line: "<path>\t<focus kind>\t<focus
# symbol>". A file's own record has no focus. Each focused record of the file ("<path>#<symbol>.dim",
# a view of one symbol opened from a diagram) is regenerated too, with the focus the
# generator stamped into it; an older record without that stamp is removed instead, and the
# editor draws it again the next time it is opened. So is one whose symbol is no longer in
# the file. A deleted file has no records left to update (see the sweep above).
tab=$(printf '\t')
jobs=$(printf '%s\n' "$files" | while IFS= read -r path; do
	[ -f "$root/$path" ] || continue
	printf '%s\t\t\n' "$path"
	for record in "$DIM_DIM_DIR/$path#"*.dim; do
		[ -f "$record" ] || continue
		focus=$(tr -d ' \t\n\r' < "$record" | grep -o '"focus":{"kind":"[a-z]*","symbol":"[^"]*"' | head -n 1)
		kind=$(printf '%s' "$focus" | sed 's/.*"kind":"\([a-z]*\)".*/\1/')
		symbol=$(printf '%s' "$focus" | sed 's/.*"symbol":"\([^"]*\)".*/\1/')
		if [ -n "$symbol" ] && ! grep -qwF -- "${symbol##*.}" "$root/$path"; then
			rm -f "$record"
			continue
		fi
		case "$kind" in
			class | function | attribute) printf '%s\t%s\t%s\n' "$path" "$kind" "$symbol" ;;
			*) rm -f "$record" ;;
		esac
	done
done)
if [ -z "$jobs" ]; then
	echo "Only deleted code files changed; removed their records."
	exit 0
fi

# While this run lasts it keeps a status file, "$DIM_DIM_DIR/.updating/<pid>", that the
# editor watches to show its "Updating diagrams" status bar entry: the first line is the number of
# records to check and each finished record appends a line. A status file left behind by a
# run that was killed is removed here. Mirrored by `dimUpdatingStatus.ts`; keep the two in
# sync.
statusDir="$DIM_DIM_DIR/.updating"
mkdir -p "$statusDir"
for stale in "$statusDir"/*; do
	[ -f "$stale" ] || continue
	kill -0 "${stale##*/}" 2>/dev/null || rm -f "$stale"
done
status="$statusDir/$$"
printf '%s\n' "$jobs" | wc -l | tr -d ' ' > "$status"
trap 'rm -f "$status"' EXIT
trap 'exit 130' INT TERM HUP

# Delegate to the shared generator, which picks the diagrams for each file's code and
# (re)writes the record only when the source has changed. Each record takes Claude about
# a minute, so DIM_HOOK_JOBS (default 4) records are generated at once to have them
# ready before the user opens them. Invoked via `sh` (as this hook itself is launched)
# so it runs even when the copied script, written without an executable bit, is not
# marked executable. Paths reach the inner shell as arguments, never as code.
printf '%s\n' "$jobs" | tr '\n' '\0' |
	xargs -0 -P "${DIM_HOOK_JOBS:-4}" -I{} sh -c '
		IFS="$5" read -r path kind symbol <<JOB
$6
JOB
		if [ -n "$kind" ]; then
			sh "$1" "$2/$path" "$3/$path#$symbol.dim" "$path" "$kind" "$symbol"
		else
			sh "$1" "$2/$path" "$3/$path.dim" "$path"
		fi
		echo >> "$4"' sh "$generator" "$root" "$DIM_DIM_DIR" "$status" "$tab" {}

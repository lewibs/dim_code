#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim built-in agent hook. Runs once when the agent finishes a turn (Stop) and,
# for every file changed in the workspace since the last commit, writes a
# companion "<file>.dim" change record capturing what was updated.
#
# Inputs (set by the caller):
#   cwd          - the workspace root, so git sees the project repository
#   DIM_DIM_DIR  - directory the ".dim" records are written under (kept out of
#                  the repo). Records mirror the repo-relative path of each
#                  changed file with a ".dim" suffix: src/foo.ts -> $DIM_DIM_DIR/src/foo.ts.dim

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "Not a git repository; skipping .dim update."
	exit 0
fi

if [ -z "$DIM_DIM_DIR" ]; then
	echo "DIM_DIM_DIR is not set; skipping .dim update."
	exit 0
fi

changed=$(git status --porcelain)
if [ -z "$changed" ]; then
	echo "No files changed since last commit; nothing to record."
	exit 0
fi

now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# git status --porcelain emits two status chars, a space, then the path. For a
# rename the path is "old -> new"; we record the new path. Other quoting cases
# (paths with unusual characters) are left to git's defaults.
echo "$changed" | while IFS= read -r line; do
	status=$(printf '%s' "$line" | cut -c1-2)
	path=$(printf '%s' "$line" | cut -c4-)
	case "$path" in
		*" -> "*) path=${path##* -> } ;;
	esac

	# Never record the records themselves.
	case "$path" in
		*.dim) continue ;;
	esac

	target="$DIM_DIM_DIR/$path.dim"
	mkdir -p "$(dirname "$target")"

	{
		echo "# Dim change record"
		echo "# file: $path"
		echo "# status: $status"
		echo "# updated: $now"
		echo "# ---"
		case "$status" in
			# Untracked file: no diff against HEAD, so capture its current contents.
			"??")
				if [ -f "$path" ]; then
					echo "new file; contents:"
					cat "$path"
				else
					echo "new (untracked) path: $path"
				fi
				;;
			*)
				diff=$(git diff HEAD -- "$path" 2>/dev/null)
				if [ -n "$diff" ]; then
					echo "$diff"
				else
					echo "(no textual diff available for status '$status')"
				fi
				;;
		esac
	} > "$target"

	echo "Wrote $target"
done

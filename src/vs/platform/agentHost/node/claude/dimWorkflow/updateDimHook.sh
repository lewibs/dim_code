#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim built-in agent hook. Runs once when the agent finishes a turn (Stop) and,
# for every file changed in the workspace since the last commit, ensures an empty
# companion "<file>.dim" record exists.
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

# git status --porcelain emits two status chars, a space, then the path. For a
# rename the path is "old -> new"; we record the new path. Other quoting cases
# (paths with unusual characters) are left to git's defaults.
echo "$changed" | while IFS= read -r line; do
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

	target="$DIM_DIM_DIR/$path.dim"
	mkdir -p "$(dirname "$target")"

	# Seed a dummy UML diagram; a `.dim` file is rendered as a mermaid diagram.
	# This mirrors `dimPlaceholderDiagram` in dimHookStorage.ts; keep them in sync.
	cat > "$target" <<'DIM_PLACEHOLDER'
classDiagram
	class Example {
		+String name
		+doWork() void
	}
	class Helper {
		+assist() void
	}
	Example --> Helper : uses
DIM_PLACEHOLDER

	echo "Wrote $target"
done

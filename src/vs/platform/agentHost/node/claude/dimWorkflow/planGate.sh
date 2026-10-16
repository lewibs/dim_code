#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim plan-mode gate, a PreToolUse hook on the file-editing tools. While any plan record
# in the workspace's ".dim/big_picture/plans/" folder has "status": "planning", it blocks
# edits to the workspace's files, so nothing changes until the user approves the plan.
# Files under ".dim/" (the plan record itself) and files outside the workspace stay
# writable. See the plan-mode skill.
#
# Inputs:
#   stdin               - the hook input JSON; its tool_input names the file to edit
#   CLAUDE_PROJECT_DIR  - the workspace root (falls back to the current directory)
#
# Exits 2 with the reason on stderr to block the edit, 0 to let it through.

root=${CLAUDE_PROJECT_DIR:-$(pwd)}
plans="$root/.dim/big_picture/plans"

[ -d "$plans" ] || exit 0
active=$(find "$plans" -name '*.dim' -type f -exec grep -l '"status"[[:space:]]*:[[:space:]]*"planning"' {} + 2>/dev/null)
[ -n "$active" ] || exit 0

input=$(cat)
target=$(printf '%s' "$input" | sed -n 's/.*"\(file_path\|notebook_path\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n 1)
[ -n "$target" ] || exit 0
case "$target" in
	/*) ;;
	*) target="$(pwd)/$target" ;;
esac

case "$target" in
	"$root/.dim/"*) exit 0 ;;
	"$root/"*) ;;
	*) exit 0 ;;
esac

{
	echo "Plan mode is on, so workspace files can't be edited yet: $target"
	echo "Active plan: $(echo "$active" | head -n 1)"
	echo "Keep the change in the plan record (update its diagrams and README) instead. Once the user approves the plan, set its \"status\" to \"approved\" and then make the edits."
} >&2
exit 2

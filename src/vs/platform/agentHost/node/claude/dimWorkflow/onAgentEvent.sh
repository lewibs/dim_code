#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim built-in agent hook. Runs on every Claude session tool-use event.

# List every file changed since the last commit (tracked modifications and
# untracked new files), using git's porcelain format for stable output.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	changed=$(git status --porcelain)
	if [ -n "$changed" ]; then
		echo "Files changed since last commit:"
		echo "$changed"
	else
		echo "No files changed since last commit."
	fi
else
	echo "Not a git repository; skipping changed-file check."
fi

# Temporary verification line: proves the hook fired in the CLI terminal
# (PreToolUse stdout is not printed inline, so write to a file we can tail).
echo "[Dim hook] fired $(date)" >> /tmp/dim-hook.log

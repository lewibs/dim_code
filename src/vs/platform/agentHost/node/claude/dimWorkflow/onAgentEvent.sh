#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim built-in agent hook. Runs on every Claude session tool-use event.
echo "hello world"
# Temporary verification line: proves the hook fired in the CLI terminal
# (PreToolUse stdout is not printed inline, so write to a file we can tail).
echo "[Dim hook] fired $(date)" >> /tmp/dim-hook.log

#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim changes generator. Writes one big-picture record, "changes.dim", that draws every
# change waiting for review in the workspace (the Source Control view's "Changes": the
# working tree against the index, see `dimPendingEdits.ts`, plus new untracked files) in
# one diagram, together with the unchanged code around it that is needed to follow them.
#
# Run only by the editor's "Open Changes Diagram" action in the Source Control view
# (through the `_dim.generateRecord` command, which is why the arguments line up with the
# per-file generator's), not by the agent hooks.
#
# Unlike generateDimDiagram.sh, Claude is given read access to the workspace, so it can
# look up the callers, types and neighbours of the changed code that the diff alone
# does not show.
#
# Arguments:
#   $1  ROOT - absolute path of the workspace folder (the git work tree).
#   $2  OUT  - absolute path of the record to write, normally
#              <ROOT>/.dim/big_picture/changes.dim.
#
# Environment:
#   DIM_CHANGES_MODEL - optional: the Claude model to draw with (default sonnet).
#
# Regeneration is gated on a hash of the changes, stamped into the record as
# `changesHash`: an unchanged set of changes costs nothing. The record is also stamped
# with the commit it was drawn on (`head`); once HEAD moves (a commit), the editor's
# commit sync clears it (see `dimDiff.ts`).
#
# Exit status, the same codes as generateDimDiagram.sh (see `dimGenerate.ts`):
#   0  generated, already up to date, or nothing to do
#   3  the Claude CLI was not found
#   5  Claude exited with an error
#   6  Claude's reply was not the expected JSON object
#
ROOT=$1
OUT=$2

cd "$ROOT" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
mkdir -p "$(dirname "$OUT")"

# Writes a record with no diagrams and the given README. Written without a `changesHash`
# so the next run draws again.
writeTextRecord() {
	printf '{\n\t"version": 1,\n\t"readme": "%s",\n\t"diagrams": []\n}\n' "$1" > "$OUT"
}

# The changes waiting for review: tracked files against the index, and the untracked files
# git does not ignore. The records folder itself is never part of them.
diffText=$(git diff --no-color --no-ext-diff -- . ':(exclude).dim' 2>/dev/null)
untracked=$(git ls-files --others --exclude-standard -- . ':(exclude).dim' 2>/dev/null)
untrackedText=""
budget=60000
for path in $untracked; do
	[ -f "$path" ] || continue
	# Skip binary files: grep -I treats them as not matching.
	grep -qI . "$path" 2>/dev/null || continue
	used=$(printf '%s' "$untrackedText" | wc -c | tr -d ' ')
	[ "$used" -ge "$budget" ] && break
	untrackedText=$(printf '%s\n--- NEW FILE %s ---\n%s\n' "$untrackedText" "$path" "$(head -c 12000 "$path")")
done

if [ -z "$diffText" ] && [ -z "$untracked" ]; then
	writeTextRecord "There are no changes waiting for review."
	echo "generateDimChanges: no changes; wrote an empty changes record."
	exit 0
fi

# Bump the version when the prompt changes, so diagrams drawn by the old one are redrawn.
promptVersion=2
changesHash=$(printf '%s\n%s\n%s\n%s' "$promptVersion" "$diffText" "$untracked" "$untrackedText" | git hash-object --stdin)
headSha=$(git rev-parse --verify -q HEAD 2>/dev/null)
if [ -f "$OUT" ] && grep -q "\"changesHash\": \"$changesHash\"" "$OUT"; then
	echo "generateDimChanges: changes record is up to date."
	exit 0
fi

claudeBin=$(command -v claude 2>/dev/null)
if [ -z "$claudeBin" ] && [ -x "$HOME/.local/bin/claude" ]; then
	claudeBin="$HOME/.local/bin/claude"
fi
if [ -z "$claudeBin" ]; then
	echo "generateDimChanges: claude CLI not found."
	exit 3
fi

# While Claude draws, keep a status file in the records folder's ".updating" folder, so the
# editor shows its "Updating diagrams" pill: one item, done when this script exits. The
# format is the Stop hook's (see updateDimHook.sh and `dimUpdatingPill.ts`).
statusDir="$(dirname "$(dirname "$OUT")")/.updating"
mkdir -p "$statusDir"
status="$statusDir/$$"
echo 1 > "$status"
trap 'rm -f "$status"' EXIT
trap 'exit 130' INT TERM HUP

echo "DIM_PROGRESS reading"

# The diagram-writing skill says how to draw each kind and how to mark changes. Its
# SKILL.md goes into the prompt; the per-kind files sit next to it for Claude to read.
skillsDir=""
for cand in \
	"$(dirname "$0")/../skills/diagram-writing" \
	"$(dirname "$0")/../../../../../sessions/skills/diagram-writing"; do
	if [ -d "$cand" ]; then
		skillsDir="$(cd "$cand" && pwd)"
		break
	fi
done
skillGeneral=""
if [ -n "$skillsDir" ] && [ -f "$skillsDir/SKILL.md" ]; then
	skillGeneral=$(awk 'BEGIN{fm=0} /^---[[:space:]]*$/{fm++; next} fm>=2{print}' "$skillsDir/SKILL.md")
fi
skillsHint=""
[ -n "$skillsDir" ] && skillsHint="Before drawing, read the skill file for each kind you draw from $skillsDir (the table above names it)."

stat=$(git diff --stat --no-color -- . ':(exclude).dim' 2>/dev/null | tail -n 40)
diffCapped=$(printf '%s' "$diffText" | head -c 120000)

prompt=$(cat <<PROMPT
You explain a set of code changes inside an IDE. The workspace is the current directory. Below are ALL the changes waiting for the user's review, across every file. Draw a big-picture view of them that gives the developer the full context: not just what changed, but the code the changes live in and work with, so someone who has never seen this code understands what the changes do and how they fit. Usually one or two Mermaid diagrams (a third only if it shows something the others cannot), and a README that explains them.

Before drawing, use your Read, Grep and Glob tools to explore the code around the changes. Read the whole of each changed file, not just the diff. Look up:
- the classes, interfaces and modules the changed code belongs to;
- the callers of changed functions, and the functions and services they call;
- the types they take, return and store;
- the other side of each message, event, command or hook they send or handle;
- the flow the changes are part of, from what starts it to where it ends.

Draw the changed elements together with that surrounding code. Unchanged elements are drawn without change marks; they are what gives the changes meaning, so include every one a developer needs to follow the flow, and leave out only code with no bearing on it. Draw every element you include whole, as the skill's "Draw every element whole" rule says: a class or interface box lists ALL of its members, changed or not; a routine shows ALL its branches and calls. Every name you draw must exist in the code.

Method for drawing (includes the catalog of kinds):
${skillGeneral}
${skillsHint}

Output rules:
- "readme" is plain text (no markdown). Start with one or two sentences on what the changes do as a whole. Then a paragraph on the surrounding code they fit into: what starts the flow, which parts take part, and where it ends. Then a short paragraph per area of change saying what changed, why it matters, and what it affects around it, naming the real classes and functions. End with a "Files:" list of each changed file (workspace-relative path), one per line, with a few words on what changed in it.
- Each diagram has "type" (the catalog's Mermaid keyword, e.g. "stateDiagram"), "label" (the catalog's label for that kind), "mermaid" (valid Mermaid source beginning with its keyword) and "links".
- "links" maps every box, member, participant and message drawn to its code: {"label": ..., "symbol": ..., "kind": "class"|"function"|"attribute"|"file", "file": "<workspace-relative path>", "detail": "<one sentence on what it does, or for a changed element, what the change does>"}.
- Mark the changes as the skill's "Showing changes" section says: a "changes" list on each diagram naming every added, changed and removed element, and each removed element kept drawn inside "%% dim:removed" / "%% dim:end" lines. Elements of a new file are "added". Context elements get no marks.
- Output ONLY the JSON object, no markdown fences and no prose outside it, shaped like:
  {"readme":"...","diagrams":[{"type":"classDiagram","label":"Structure","mermaid":"classDiagram\n ...","links":[{"label":"Foo","symbol":"Foo","kind":"class","file":"src/foo.ts","detail":"..."}],"changes":[{"label":"Foo.bar","change":"added"}]}]}

--- CHANGED FILES ---
$stat
--- BEGIN DIFF (index to working tree) ---
$diffCapped
--- END DIFF ---
--- BEGIN NEW FILES (untracked) ---
$untrackedText
--- END NEW FILES ---
PROMPT
)

echo "DIM_PROGRESS claude"

model="${DIM_CHANGES_MODEL:-sonnet}"
errFile="$OUT.err.$$"
result=$(printf '%s' "$prompt" | "$claudeBin" -p --model "$model" --allowedTools Read Grep Glob 2>"$errFile")
claudeStatus=$?
claudeError=$(head -c 500 "$errFile" 2>/dev/null)
rm -f "$errFile"
if [ "$claudeStatus" -ne 0 ]; then
	echo "generateDimChanges: Claude exited with $claudeStatus."
	[ -n "$claudeError" ] || claudeError=$(printf '%s' "$result" | head -c 500)
	printf '%s\n' "$claudeError" >&2
	exit 5
fi

# Claude may talk before the object despite the rules: keep from the first line that
# opens it, and drop any markdown fences.
result=$(printf '%s\n' "$result" | sed '/^[[:space:]]*```/d' | sed -n '/^[[:space:]]*{/,$p')
if [ -z "$result" ]; then
	echo "generateDimChanges: Claude output unusable."
	exit 6
fi

echo "DIM_PROGRESS checking"

# Check the diagrams build, as generateDimDiagram.sh does, and drop any that do not. A
# reply that is not JSON at all is not saved.
nodeBin="${DIM_NODE:-$(command -v node 2>/dev/null)}"
validator="$(dirname "$0")/validateDimDiagrams.js"
[ -f "$validator" ] || validator="$(dirname "$0")/validateDimDiagrams.mjs"
mermaidDir="${DIM_MERMAID_DIR:-$(dirname "$0")/../../../../../../../extensions/mermaid-markdown-features/node_modules}"
if [ -n "$nodeBin" ] && [ -f "$validator" ] && [ -d "$mermaidDir/mermaid" ]; then
	checked=$(printf '%s\n' "$result" | "$nodeBin" "$validator" "$mermaidDir" 2>/dev/null)
	case $? in
		1) result=$checked ;;
		3)
			echo "generateDimChanges: Claude's reply is not valid JSON."
			exit 6
			;;
	esac
fi

echo "DIM_PROGRESS saving"

tmp="$OUT.tmp.$$"
printf '%s\n' "$result" \
	| sed "1 s|{|{\"version\": 1, \"changesHash\": \"$changesHash\", \"head\": \"$headSha\",|" \
	> "$tmp" && mv "$tmp" "$OUT"
echo "generateDimChanges: generated the changes diagram."

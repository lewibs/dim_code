#!/bin/sh
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Dim diagram generator. Given one source file, decides which kind of mermaid
# diagram best fits that code and writes a companion "<file>.dim" record for it.
#
# This is the single generation step shared by every Dim trigger: the agent Stop
# hook (updateDimHook.sh) calls it for each code file changed in a turn, and the
# editor's file-open path (the `_dim.generateRecord` command) calls it for the
# file being opened. The kind of diagram is not hard-coded: the code is handed to
# Claude Haiku, which picks the best-fit diagram type from the Dim catalog and
# draws it. Keep that catalog in sync with `dimDiagramTypes.ts` / `PLAN.md`.
#
# Arguments:
#   $1  SRC  - absolute path of the source file to describe.
#   $2  OUT  - absolute path of the ".dim" record to write.
#   $3  REL  - the source file's workspace-relative path (stored in the record so
#              the viewer can offer a "Raw" view of it).
#
# Regeneration is gated on the source's content hash, which is stamped into the
# record as `sourceHash`: the record is (re)generated only when it does not exist
# yet or when the source has changed since it was last generated, so repeated
# opens of an unchanged file cost nothing.

SRC="$1"
OUT="$2"
REL="$3"

if [ -z "$SRC" ] || [ -z "$OUT" ] || [ -z "$REL" ]; then
	echo "generateDimDiagram: missing argument (src/out/rel); skipping."
	exit 0
fi
if [ ! -f "$SRC" ]; then
	echo "generateDimDiagram: source not found: $SRC"
	exit 0
fi

# Content hash of the source, used as the freshness stamp. Prefer a real digest;
# fall back to cksum where none is available. Whatever is used here must match the
# algorithm the editor compares against, so the record stores the hex it produced.
hashSource() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		cksum "$1" | cut -d' ' -f1
	fi
}
srcHash=$(hashSource "$SRC")

# Already up to date for this exact source content: nothing to do.
if [ -f "$OUT" ]; then
	existingHash=$(sed -n 's/.*"sourceHash"[[:space:]]*:[[:space:]]*"\([0-9a-zA-Z]*\)".*/\1/p' "$OUT" 2>/dev/null | head -n1)
	if [ -n "$existingHash" ] && [ "$existingHash" = "$srcHash" ]; then
		echo "generateDimDiagram: $REL unchanged; keeping existing record."
		exit 0
	fi
fi

mkdir -p "$(dirname "$OUT")"

# Writes the two-view placeholder record. Used when Claude is unavailable or its
# output cannot be used; written without a `sourceHash` so a later run retries.
# Mirrors `dimPlaceholderDiagrams` in dimHookStorage.ts; keep them in sync.
writePlaceholder() {
	cat > "$OUT" <<DIM_RECORD
{
	"version": 1,
	"source": "$REL",
	"diagrams": [
		{
			"type": "classDiagram",
			"label": "Structure",
			"mermaid": "classDiagram\n\tclass Example {\n\t\t+String name\n\t\t+doWork() void\n\t}\n\tclass Helper {\n\t\t+assist() void\n\t}\n\tExample --> Helper : uses\n"
		},
		{
			"type": "sequenceDiagram",
			"label": "Behavior",
			"mermaid": "sequenceDiagram\n\tparticipant Example\n\tparticipant Helper\n\tExample->>Helper: assist()\n\tHelper-->>Example: result\n"
		}
	]
}
DIM_RECORD
	echo "generateDimDiagram: wrote placeholder for $REL"
}

# Locate the Claude CLI. It is normally on PATH; also try the per-user install
# location in case the hook runs with a minimal desktop-launch environment.
claudeBin=$(command -v claude 2>/dev/null)
if [ -z "$claudeBin" ] && [ -x "$HOME/.local/bin/claude" ]; then
	claudeBin="$HOME/.local/bin/claude"
fi
if [ -z "$claudeBin" ]; then
	echo "generateDimDiagram: claude CLI not found; seeding placeholder for $REL."
	[ -f "$OUT" ] || writePlaceholder
	exit 0
fi

# Hand the code to Haiku and let it choose the diagram type(s). The code is capped
# so a very large file does not blow up the prompt. The model is told to emit ONLY
# a JSON array of diagram objects, which we wrap into the record below.
code=$(head -c 60000 "$SRC")
prompt=$(cat <<PROMPT_HEADER
You produce Mermaid diagrams for source files shown inside an IDE. Look at the code and pick the SINGLE best-fit diagram type for it; add a SECOND only when a different view genuinely adds understanding.

Diagram catalog (mermaid keyword = label = when to use):
- classDiagram = Structure = a class/service/module: its types, members and relationships. The usual default for object-oriented or service code.
- sequenceDiagram = Behavior = a function/method/endpoint that calls two or more collaborators, or an event/message flow: who calls whom, in order, across participants.
- flowchart = Logic = one routine whose own branching/looping control flow is the point, or a high-level component graph.
- stateDiagram = States = code that models a lifecycle or state machine (a session, a connection, a picker).
- erDiagram = Data = a relational / SQL-shaped schema or data model: entities and their relationships.
- mindmap = Overview = a top-level feature tree or responsibilities breakdown.

Rules:
- Base the diagram on what THIS code actually contains; use real identifiers from it.
- "label" MUST be exactly one of: Structure, Behavior, Logic, States, Data, Overview (matching the type you chose).
- "mermaid" MUST be valid Mermaid source beginning with the diagram's keyword.
- Output ONLY a JSON array, no markdown fences and no prose, shaped like:
  [{"type":"classDiagram","label":"Structure","mermaid":"classDiagram\n ..."}]

File: $REL
--- BEGIN CODE ---
$code
--- END CODE ---
PROMPT_HEADER
)

timeoutCmd=""
if command -v timeout >/dev/null 2>&1; then
	timeoutCmd="timeout 90"
fi

result=$(printf '%s' "$prompt" | $timeoutCmd "$claudeBin" -p --model haiku 2>/dev/null)

# Strip any stray markdown code fences the model may have added.
result=$(printf '%s\n' "$result" | sed '/^[[:space:]]*```/d')

# Accept only output that actually looks like the requested JSON array.
firstChar=$(printf '%s' "$result" | sed -e 's/^[[:space:]]*//' | cut -c1)
if [ "$firstChar" != "[" ]; then
	echo "generateDimDiagram: Claude output unusable for $REL; seeding placeholder."
	[ -f "$OUT" ] || writePlaceholder
	exit 0
fi

# Wrap the model's diagram array into the record, stamping the freshness hash. The
# model output is valid JSON, so concatenating it as the `diagrams` value yields a
# valid record. `$REL`/`$srcHash` contain no JSON-special characters.
tmp="$OUT.tmp.$$"
{
	printf '{\n\t"version": 1,\n\t"source": "%s",\n\t"sourceHash": "%s",\n\t"diagrams": ' "$REL" "$srcHash"
	printf '%s' "$result"
	printf '\n}\n'
} > "$tmp" && mv "$tmp" "$OUT"
echo "generateDimDiagram: generated diagram for $REL"

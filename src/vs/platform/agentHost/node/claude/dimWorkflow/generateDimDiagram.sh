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
# The source's direct local imports are resolved to their TypeScript sources and
# handed to Haiku as extra context, so a type the file references but does not
# itself declare (e.g. an imported class) is drawn with its real members instead
# of as an empty box. See the import-gathering step below for its scope and limits.
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

# Writes an empty record (no diagrams), so the file shows as raw source. Used when
# Claude is unavailable or its output cannot be used: no placeholder or default
# diagram is ever shown, only a real diagram chosen from the file's own code.
# Written without a `sourceHash` so a later run retries.
writeEmptyRecord() {
	cat > "$OUT" <<DIM_RECORD
{
	"version": 1,
	"source": "$REL",
	"diagrams": []
}
DIM_RECORD
	echo "generateDimDiagram: wrote empty record (raw view) for $REL"
}

# Locate the Claude CLI. It is normally on PATH; also try the per-user install
# location in case the hook runs with a minimal desktop-launch environment.
claudeBin=$(command -v claude 2>/dev/null)
if [ -z "$claudeBin" ] && [ -x "$HOME/.local/bin/claude" ]; then
	claudeBin="$HOME/.local/bin/claude"
fi
if [ -z "$claudeBin" ]; then
	echo "generateDimDiagram: claude CLI not found; leaving $REL as raw."
	[ -f "$OUT" ] || writeEmptyRecord
	exit 0
fi

# Gather the file's direct local imports so types it references but does not itself
# declare are not drawn empty. Each workspace-relative specifier (./ or ../) is
# resolved to its TypeScript source and handed to Haiku as *context* only, to fill
# in the members of referenced types. Scope and limits, kept deliberately small so
# the prompt stays bounded and cheap:
#   - one level deep (the file's own imports, not their imports);
#   - relative specifiers only, resolved to a sibling .ts (bare/package imports and
#     side-effect imports without a `from` are ignored);
#   - each dependency is capped, and the combined context is capped overall.
# Regeneration is still gated on the main file's hash alone (that is what the editor
# compares), so editing only an imported file will not refresh this record until the
# importing file itself changes.
srcDir=$(dirname "$SRC")
importSection=""
importBudget=40000
imports=$(grep -oE "from[[:space:]]+['\"]\.\.?/[^'\"]+['\"]" "$SRC" 2>/dev/null \
	| sed -e "s/^from[[:space:]]*['\"]//" -e "s/['\"]\$//" \
	| sort -u)
for spec in $imports; do
	cand="$srcDir/$spec"
	case "$cand" in
		*.js) dep="${cand%.js}.ts" ;;
		*.ts) dep="$cand" ;;
		*) dep="$cand.ts" ;;
	esac
	[ -f "$dep" ] || continue
	used=$(printf '%s' "$importSection" | wc -c | tr -d ' ')
	[ "$used" -ge "$importBudget" ] && break
	piece=$(head -c 8000 "$dep")
	importSection=$(printf '%s\n--- IMPORTED FROM %s ---\n%s\n' "$importSection" "$spec" "$piece")
done

importBlock=""
if [ -n "$importSection" ]; then
	importBlock=$(printf '\nThe following are definitions imported by the file above, provided ONLY as context so you can fill in the members of types the main file references but does not itself declare. Do NOT draw diagrams for them and do NOT center the diagram on them.\n--- BEGIN IMPORTED DEFINITIONS ---%s--- END IMPORTED DEFINITIONS ---\n' "$importSection")
fi

# Hand the code to Haiku and let it choose the diagram type(s) AND write a short
# overview of the file. The code is capped so a very large file does not blow up the
# prompt. The model is told to emit ONLY a JSON object with a "readme" overview and a
# "diagrams" array, which we wrap into the record below.
code=$(head -c 60000 "$SRC")

# The diagram catalog — which kinds exist and when to use each — is the single source
# of truth, read here at runtime. It sits next to this script (and is copied beside it
# into the materialized CLI-terminal plugin). The DimDiagramType enum in
# dimDiagramTypes.ts mirrors its keywords for TypeScript, guarded by a drift test. We
# build both the prompt's catalog block and the allowed-label list from it, so there is
# nothing to keep in sync by hand.
catalogFile="$(dirname "$0")/dimDiagramCatalog.md"
catalogLines=""
catalogLabels=""
if [ -f "$catalogFile" ]; then
	headerDone=0
	# The catalog is a markdown table "| entity | diagram | keyword | label |" embedded in
	# a markdown doc. Parse ONLY the table rows and ignore the surrounding prose: a table
	# row starts with "|", so its leading cell (before the first "|") is empty. Skip prose
	# (non-empty leading cell), the --- divider, and the first table row (the header).
	while IFS='|' read -r _lead entity diagram keyword label _rest; do
		# Not a table row (prose/blank): the text before the first "|" is non-empty.
		if [ -n "$(printf '%s' "$_lead" | tr -d ' \t')" ]; then
			continue
		fi
		# A row with no cells at all (e.g. a blank line) is not a table row either.
		if [ -z "$(printf '%s' "$entity$diagram$keyword$label" | tr -d ' \t')" ]; then
			continue
		fi
		# The |---|---| divider.
		case "$entity$diagram$keyword$label" in
			*---*) continue ;;
		esac
		# The first surviving row is the table header; skip it, keep the rest as data.
		if [ "$headerDone" = 0 ]; then
			headerDone=1
			continue
		fi
		entity=$(printf '%s' "$entity" | sed 's/^[ \t]*//;s/[ \t]*$//')
		diagram=$(printf '%s' "$diagram" | sed 's/^[ \t]*//;s/[ \t]*$//')
		keyword=$(printf '%s' "$keyword" | sed 's/^[ \t]*//;s/[ \t]*$//')
		label=$(printf '%s' "$label" | sed 's/^[ \t]*//;s/[ \t]*$//')
		catalogLines="${catalogLines}- ${keyword} = ${label} = ${entity} → ${diagram}
"
		catalogLabels="${catalogLabels}${label}, "
	done < "$catalogFile"
	catalogLabels=$(printf '%s' "$catalogLabels" | sed 's/, $//')
fi
if [ -z "$catalogLines" ]; then
	# Degraded fallback when the catalog file is missing (e.g. a stale plugin install):
	# let the model pick any standard diagram rather than failing outright.
	catalogLines="- use whichever standard Mermaid diagram (classDiagram, sequenceDiagram, flowchart, stateDiagram, erDiagram) best fits the code"
	catalogLabels="a short title for the view"
fi

prompt=$(cat <<PROMPT_HEADER
You document source files shown inside an IDE. For the code below, do two things: (1) write a plain-English description of what the file is for and the role/intent of its main class, functions or module, and (2) draw the Mermaid diagram(s) that genuinely help someone understand THIS code. Pick only the views that earn their place: one is usually right, a second only when it shows something the first cannot. Do NOT pad with a diagram that merely restates the overview or lists the file's parts; every diagram must reveal real structure or behavior from the code. Order them most-useful first.

Diagram catalog (mermaid keyword = label = when to use):
${catalogLines}
Rules:
- When the file holds several functions (a module with no single central class), do NOT just flowchart one of them. First decide the file's shape, then prefer a Structure view of the whole module (its interfaces plus its functions and their call relationships); add a Logic flowchart only for an individual function whose branching is genuinely the point.
- "readme" is a plain-text description (no markdown) of THIS file: what it is for, the role/intent of its main class, functions or module, the responsibility it owns and the problem it solves (not just a restatement of its name). Keep it to a few sentences.
- Base the diagram on what THIS code actually contains; use real identifiers from it.
- When a type this file references is defined in the imported definitions provided below, populate it with its real members; never leave a referenced type as an empty box.
- "label" MUST be exactly one of: ${catalogLabels} (matching the type you chose).
- "mermaid" MUST be valid Mermaid source beginning with the diagram's keyword.
- "diagrams" holds only the views that genuinely help (often just one), each a distinct type; never add a type just to have more.
- Output ONLY a JSON object, no markdown fences and no prose outside it, shaped EXACTLY like (note the leading "{"):
  {"readme":"...","diagrams":[{"type":"classDiagram","label":"Structure","mermaid":"classDiagram\n ..."},{"type":"sequenceDiagram","label":"Behavior","mermaid":"sequenceDiagram\n ..."}]}

File: $REL
--- BEGIN CODE ---
$code
--- END CODE ---
$importBlock
PROMPT_HEADER
)

timeoutCmd=""
if command -v timeout >/dev/null 2>&1; then
	timeoutCmd="timeout 90"
fi

result=$(printf '%s' "$prompt" | $timeoutCmd "$claudeBin" -p --model haiku 2>/dev/null)

# Strip any stray markdown code fences the model may have added, then drop any leading
# blank lines so the opening brace lands on the first line for the inject step below.
result=$(printf '%s\n' "$result" | sed '/^[[:space:]]*```/d' | sed '/./,$!d')

# Accept only output that actually looks like the requested JSON object.
firstChar=$(printf '%s' "$result" | sed -e 's/^[[:space:]]*//' | cut -c1)
if [ "$firstChar" != "{" ]; then
	echo "generateDimDiagram: Claude output unusable for $REL; leaving as raw."
	[ -f "$OUT" ] || writeEmptyRecord
	exit 0
fi

# Wrap the model's object into the record by injecting our fields right after its
# opening brace, keeping the model's "readme" and "diagrams" fields intact. Only the
# first "{" (the object opener) on line 1 is touched, so a brace anywhere inside the
# readme text is left alone. `$REL`/`$srcHash` contain no JSON-special characters; the
# `|` delimiter avoids the "/" in relative paths.
tmp="$OUT.tmp.$$"
printf '%s\n' "$result" \
	| sed "1 s|{|{\"version\": 1, \"source\": \"$REL\", \"sourceHash\": \"$srcHash\",|" \
	> "$tmp" && mv "$tmp" "$OUT"
echo "generateDimDiagram: generated diagram and overview for $REL"

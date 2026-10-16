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

# The diagram-writing skill is the single source of truth, read here at runtime. Its
# SKILL.md holds the general method AND a markdown table of the kinds (keyword + label +
# per-kind skill file); each kind's detailed drawing instructions live in its own file
# next to SKILL.md. We inject the general method (with its table) plus the skill for each
# kind so Haiku follows the right instructions for the view it picks, and we build the
# allowed-label list from the same table. The DimDiagramType enum in dimDiagramTypes.ts
# mirrors the table's keywords for TypeScript, guarded by a drift test, so there is
# nothing to keep in sync by hand. The skill dir sits in a fixed spot relative to the
# source tree, but the generator is copied into the CLI-terminal plugin's hooks/ folder
# while the skills are copied into its skills/ folder, so resolve whichever of the two
# known layouts exists.
skillsDir=""
for cand in \
	"$(dirname "$0")/../skills/diagram-writing" \
	"$(dirname "$0")/../../../../../sessions/skills/diagram-writing"; do
	if [ -d "$cand" ]; then
		skillsDir="$cand"
		break
	fi
done
skillFile="$skillsDir/SKILL.md"

# The general diagram-writing method (with the kinds table), from SKILL.md's body —
# everything after its YAML front matter, i.e. after the second "---" line.
skillGeneral=""
if [ -n "$skillsDir" ] && [ -f "$skillFile" ]; then
	skillGeneral=$(awk 'BEGIN{fm=0} /^---[[:space:]]*$/{fm++; next} fm>=2{print}' "$skillFile")
fi
if [ -z "$skillGeneral" ]; then
	# Degraded fallback when the skill files are missing (e.g. a stale plugin install):
	# describe the kinds inline so the model can still pick a sensible view.
	skillGeneral="Choose from these kinds (mermaid keyword = label): classDiagram = Structure, sequenceDiagram = Behavior, flowchart = Logic, stateDiagram = States, erDiagram = Data. Pick only the views that earn their place: one is usually right, a second only when it shows something the first cannot. Do NOT pad with a diagram that merely restates the overview. When the file is standalone functions + interfaces, prefer a Structure view of the whole module (its interfaces + functions with call edges), not a flowchart of one function. Base every diagram on THIS code using its real identifiers, and populate referenced types from the imported definitions instead of leaving empty boxes."
fi

# Parse the kinds table in SKILL.md for the allowed-label list and to pull in each kind's
# own skill file. A table row starts with "|", so its leading cell (before the first "|")
# is empty; skip prose (non-empty leading cell), the --- divider, and the header row.
catalogLabels=""
skillSections=""
if [ -n "$skillsDir" ] && [ -f "$skillFile" ]; then
	headerDone=0
	while IFS='|' read -r _lead entity diagram keyword label skill _rest; do
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
		keyword=$(printf '%s' "$keyword" | sed 's/^[ \t]*//;s/[ \t]*$//')
		label=$(printf '%s' "$label" | sed 's/^[ \t]*//;s/[ \t]*$//')
		skill=$(printf '%s' "$skill" | sed 's/^[ \t]*//;s/[ \t]*$//')
		catalogLabels="${catalogLabels}${label}, "
		# Pull in this kind's skill so the prompt carries how to draw it, headed so the
		# model can match the table row to the instructions for the kind it chooses.
		if [ -n "$skill" ] && [ -f "$skillsDir/$skill" ]; then
			skillSections="${skillSections}
=== Skill for ${label} (${keyword}) ===
$(cat "$skillsDir/$skill")
"
		fi
	done < "$skillFile"
	catalogLabels=$(printf '%s' "$catalogLabels" | sed 's/, $//')
fi
if [ -z "$catalogLabels" ]; then
	# Degraded fallback when the skill files are missing (e.g. a stale plugin install).
	catalogLabels="a short title for the view"
fi

prompt=$(cat <<PROMPT_HEADER
You document source files shown inside an IDE. For the code below, do two things: (1) write a plain-English description of what the file is for and the role/intent of its main class, functions or module, and (2) draw the Mermaid diagram(s) that genuinely help someone understand THIS code.

Method (includes the catalog of kinds you may choose from):
${skillGeneral}

For the kind(s) you choose, follow that kind's skill below (match the catalog label to its skill heading):
${skillSections}
Output rules:
- "readme" is a plain-text description (no markdown) of THIS file: what it is for, the role/intent of its main class, functions or module, the responsibility it owns and the problem it solves (not just a restatement of its name). Keep it to a few sentences.
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

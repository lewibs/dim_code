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
#   $4  FOCUS_KIND   - optional: class, function or attribute, to describe one symbol
#                      of the file rather than the whole file (a "focused" view,
#                      opened by clicking that symbol in a diagram).
#   $5  FOCUS_SYMBOL - optional, with $4: the symbol, e.g. Session.state.
# The focus kinds mirror `DimFocusKind` in dimHookStorage.ts; keep the two in sync.
#
# Environment:
#   DIM_DIFF_BASE - optional: a git revision for the diagrams to show changes against.
#                   By default they show the changes waiting for review: the ones not
#                   accepted (staged in git) yet, see `dimPendingEdits.ts`. Lets another
#                   caller draw the changes between two versions instead.
#
# Regeneration is gated on the source's content hash, which is stamped into the
# record as `sourceHash`: the record is (re)generated only when it does not exist
# yet or when the source has changed since it was last generated, so repeated
# opens of an unchanged file cost nothing.
#
# When the file differs from the diff base, the diagrams also mark what changed
# (see "Showing changes" in the diagram-writing skill), and the record is stamped
# with a `diff` object naming the base commit. Committing the changes resets the
# record without regenerating it: the editor drops the marks and the removed
# elements (see `dimDiff.ts` in the mermaid-markdown-features extension).
#
# Exit status tells the caller what happened, so the editor can show it (the agent
# hook ignores it). On a failure, stderr carries any detail (e.g. Claude's error).
#   0  generated, already up to date, or nothing to do
#   3  the Claude CLI was not found
#   5  Claude exited with an error
#   6  Claude's reply was not the expected JSON object
# Keep these codes in sync with `dimGenerate.ts` in the mermaid-markdown-features extension.
#
# While it works, it prints a "DIM_PROGRESS <step>" line on stdout as it starts each
# step (reading, claude, saving), which the editor shows as live progress.

SRC="$1"
OUT="$2"
REL="$3"
FOCUS_KIND="$4"
FOCUS_SYMBOL="$5"

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

# A test file's README also lists its tests (see the TESTS block of the prompt below).
# Recognized by the common naming conventions for test files and test folders.
isTestFile=0
case "$REL" in
	*.test.* | *.spec.* | *_test.* | test_* | */test_* | test/* | tests/* | */test/* | */tests/* | */__tests__/*)
		isTestFile=1
		;;
esac
# A focused view describes one symbol, not the file, so it gets no tests table.
[ -n "$FOCUS_KIND" ] && isTestFile=0

# How the file differs from the diff base, so the diagrams can show it:
#   none    - not in a git repository, no base commit yet, or an ignored new file;
#   clean   - the same as in the base;
#   changed - edited since the base ($diffText holds the diff);
#   new     - not in the base at all.
# Run from the file's own folder with its bare name, so the workspace does not have
# to be the repository root.
diffState=none
diffText=""
baseSha=""
pendingHash=""
srcDir=$(dirname "$SRC")
srcName=$(basename "$SRC")
if [ -z "$DIM_DIFF_BASE" ] && git -C "$srcDir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	# The changes waiting for review: the file against its staged (accepted) version.
	# The staged blob stamps the record, so accepting some of the changes redraws it.
	indexSha=$(git -C "$srcDir" ls-files -s -- "$srcName" 2>/dev/null | head -n1 | cut -d' ' -f2)
	if [ -n "$indexSha" ]; then
		pendingHash=$indexSha
		diffText=$(git -C "$srcDir" diff --no-color --no-ext-diff -- "$srcName" 2>/dev/null | head -c 30000)
		if [ -n "$diffText" ]; then
			diffState=changed
		else
			diffState=clean
		fi
	elif ! git -C "$srcDir" check-ignore -q -- "$srcName" 2>/dev/null; then
		diffState=new
		pendingHash=new
	fi
elif git -C "$srcDir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	baseSha=$(git -C "$srcDir" rev-parse --verify -q "${DIM_DIFF_BASE:-HEAD}^{commit}" 2>/dev/null)
	if [ -n "$baseSha" ]; then
		if git -C "$srcDir" cat-file -e "$baseSha:./$srcName" 2>/dev/null; then
			diffText=$(git -C "$srcDir" diff --no-color --no-ext-diff "$baseSha" -- "$srcName" 2>/dev/null | head -c 30000)
			if [ -n "$diffText" ]; then
				diffState=changed
			else
				diffState=clean
			fi
		elif ! git -C "$srcDir" check-ignore -q -- "$srcName" 2>/dev/null; then
			diffState=new
		fi
	fi
fi

# Already up to date for this exact source content: nothing to do. A test file's record
# from before the tests table existed has no "tests" field; regenerate it once so it
# gains one (the generator always writes the field for a test file, even when empty).
# Likewise a record must show changes exactly when the file has them: one drawn before
# the file was edited (e.g. from before changes were shown) is regenerated to mark them.
# A record whose changes were committed since is reset by the editor, not regenerated.
# A changed test file's record must also mark its tests (its diff stamp says "tests": true);
# one drawn before tests were marked is regenerated once to mark them.
if [ -f "$OUT" ]; then
	existingHash=$(sed -n 's/.*"sourceHash"[[:space:]]*:[[:space:]]*"\([0-9a-zA-Z]*\)".*/\1/p' "$OUT" 2>/dev/null | head -n1)
	hasDiff=0
	grep -q '[{,[:space:]]"diff"[[:space:]]*:' "$OUT" 2>/dev/null && hasDiff=1
	wantsDiff=0
	case "$diffState" in changed | new) wantsDiff=1 ;; esac
	# The record must also be measured against the same staged version: accepting some of
	# the changes redraws it.
	existingPending=$(sed -n 's/.*"pending"[[:space:]]*:[[:space:]]*"\([0-9a-zA-Z]*\)".*/\1/p' "$OUT" 2>/dev/null | head -n1)
	[ "$wantsDiff" = 1 ] || pendingHash=""
	if [ -n "$existingHash" ] && [ "$existingHash" = "$srcHash" ] && [ "$hasDiff" = "$wantsDiff" ] && [ "$existingPending" = "$pendingHash" ]; then
		testsMarked=1
		if [ "$isTestFile" = 1 ] && [ "$diffState" = changed ] && ! tr -d '\n' < "$OUT" 2>/dev/null | grep -q '"diff"[[:space:]]*:[[:space:]]*{[^}]*"tests"[[:space:]]*:[[:space:]]*true'; then
			testsMarked=0
		fi
		if [ "$testsMarked" = 1 ] && { [ "$isTestFile" = 0 ] || grep -q '"tests"[[:space:]]*:' "$OUT" 2>/dev/null; }; then
			echo "generateDimDiagram: $REL unchanged; keeping existing record."
			exit 0
		fi
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
	exit 3
fi

# Reports the step now starting (see the header); the step names are a contract with
# `dimGenerate.ts`.
progress() {
	echo "DIM_PROGRESS $1"
}

progress reading

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
	# Name the dependency by its workspace-relative path, so links to its symbols can
	# say which file defines them. The workspace root is SRC with REL taken off its end.
	depAbs="$(cd "$(dirname "$dep")" && pwd)/$(basename "$dep")"
	depRel="${depAbs#"${SRC%"$REL"}"}"
	importSection=$(printf '%s\n--- IMPORTED FROM %s (file: %s) ---\n%s\n' "$importSection" "$spec" "$depRel" "$piece")
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

# A focused view describes one symbol of the file (see "Focused views" in the skill).
# The kind and symbol come from the editor's own URI parsing, which only accepts
# dotted identifiers, so they are safe to put into the prompt as they are.
focusBlock=""
case "$FOCUS_KIND" in
	class | function | attribute)
		if [ -n "$FOCUS_SYMBOL" ]; then
			focusBlock="
FOCUS: this is a focused view. Document ONLY the ${FOCUS_KIND} \"${FOCUS_SYMBOL}\" of this file, following the skill's Focused views rules for a ${FOCUS_KIND}; the readme describes only that symbol.
"
		fi
		;;
esac

# A test file additionally gets a "tests" table in its README: one row per test, saying
# what it checks, its input, the expected result and what it mocks, so a reader can see
# at a glance what is tested and how much of the real code each test exercises.
testsBlock=""
testsShape=""
if [ "$isTestFile" = 1 ]; then
	testsBlock='
TESTS: this is a test file. Also output a "tests" array with one entry per test case (every test/it call, in file order; expand a table-driven loop into one entry per case when the cases are listed in the file). Each entry has:
- "suite": the enclosing suite/describe names joined with " > " ("" when there is none);
- "name": the test name exactly as written;
- "checks": what behavior or rule the test verifies, in plain words (not a restatement of the name);
- "input": the concrete input or setup the code under test is driven with (values, fixtures, state);
- "expected": the concrete result the test asserts (return value, thrown error, emitted event, final state);
- "mocks": everything the test replaces with a mock, stub, spy, fake or test double instead of the real implementation (e.g. "IFileService (in-memory fake)", "Date.now (stubbed)", "fetch (sinon stub)"), including ones created in a shared setup/beforeEach the test relies on; [] when the test runs only real code. Do not count plain test data, fixtures or real in-memory implementations shipped by the product as mocks.
Keep each field short (one sentence or a compact value). Output "tests": [] if the file contains no tests.
'
	testsShape=',"tests":[{"suite":"...","name":"...","checks":"...","input":"...","expected":"...","mocks":["..."]}]'
fi

# Changes since the diff base are marked in the diagrams (see "Showing changes" in the
# skill). A new file is shown as wholly added by the viewer, so it needs no marks.
changesBlock=""
changesShape=""
if [ -n "$pendingHash" ]; then
	changesLead="this file has changes that the user has not reviewed yet"
	changesFrom="the reviewed code"
	newSince="the user last reviewed the code"
else
	changesLead="this file has changes since its last commit"
	changesFrom="the committed code"
	newSince="the last commit"
fi
case "$diffState" in
	changed)
		changesBlock="
CHANGES: $changesLead. The diff below goes from $changesFrom (\"-\" lines) to the current code (\"+\" lines, the CODE above). Show the changes in every diagram as the skill's \"Showing changes\" section and your kind's skill describe: list each added, changed and removed element in the diagram's \"changes\", and keep each removed element drawn, wrapped in \"%% dim:removed\" / \"%% dim:end\" lines. The readme still describes only the current code: do not mention the changes or the diff in it, as it is kept after they are committed.
--- BEGIN DIFF ---
$diffText
--- END DIFF ---
"
		changesShape=',"changes":[{"label":"Foo.bar","change":"added"}]'
		if [ "$isTestFile" = 1 ]; then
			changesBlock="$changesBlock
Also mark the tests the diff touched: give each such entry of \"tests\" a \"change\" field: \"added\" (a new test), \"changed\" (its name, setup, input or assertions changed) or \"removed\" (it is gone from the current code). Keep each removed test listed, described as it was before the change, at its old place in the order. Leave \"change\" out of tests the diff did not touch.
"
			testsShape=',"tests":[{"suite":"...","name":"...","checks":"...","input":"...","expected":"...","mocks":["..."],"change":"added"}]'
		fi
		;;
	new)
		changesBlock="
CHANGES: this file is new since $newSince. The viewer shows the whole diagram as added, so output no \"changes\" and no removed markers.
"
		;;
esac

prompt=$(cat <<PROMPT_HEADER
You document source files shown inside an IDE. For the code below, do two things: (1) write a plain-English description of what the file is for and the role/intent of its main class, functions or module, and (2) draw the Mermaid diagram(s) that genuinely help someone understand THIS code.

Method (includes the catalog of kinds you may choose from):
${skillGeneral}

For the kind(s) you choose, follow that kind's skill below (match the catalog label to its skill heading):
${skillSections}
Output rules:
- "readme" is a plain-text description (no markdown) of THIS file: what it is for, the role/intent of its main class, functions or module, the responsibility it owns and the problem it solves (not just a restatement of its name). Keep it to a few sentences.
- "type" MUST be exactly the catalog's Mermaid keyword for the kind (e.g. "stateDiagram", even though its source begins "stateDiagram-v2").
- "label" MUST be exactly one of: ${catalogLabels} (matching the type you chose).
- "mermaid" MUST be valid Mermaid source beginning with the diagram's keyword.
- "diagrams" holds only the views that genuinely help (often just one), each a distinct type; never add a type just to have more.
- Each diagram has a "links" list that maps every box, member, participant and message it draws to the code it stands for, as the skill's links section describes. "file" is the workspace-relative path: "$REL" for this file's own symbols, and the "file:" path shown for each imported definition.
- Output ONLY a JSON object, no markdown fences and no prose outside it, shaped EXACTLY like (note the leading "{"):
  {"readme":"..."${testsShape},"diagrams":[{"type":"classDiagram","label":"Structure","mermaid":"classDiagram\n ...","links":[{"label":"Foo","symbol":"Foo","kind":"class","file":"$REL"}]${changesShape}},{"type":"sequenceDiagram","label":"Behavior","mermaid":"sequenceDiagram\n ...","links":[]}]}
${focusBlock}${testsBlock}${changesBlock}
File: $REL
--- BEGIN CODE ---
$code
--- END CODE ---
$importBlock
PROMPT_HEADER
)

progress claude

# No time limit: Claude runs until it answers or fails, and the editor shows progress
# meanwhile. Keep Claude's stderr (rather than discarding it) so a failure can say why.
errFile="$OUT.err.$$"
result=$(printf '%s' "$prompt" | "$claudeBin" -p --model haiku 2>"$errFile")
claudeStatus=$?
claudeError=$(head -c 500 "$errFile" 2>/dev/null)
rm -f "$errFile"
if [ "$claudeStatus" -ne 0 ]; then
	echo "generateDimDiagram: Claude exited with $claudeStatus for $REL; leaving as raw."
	# Claude may report its error on stdout instead (e.g. a login prompt).
	[ -n "$claudeError" ] || claudeError=$(printf '%s' "$result" | head -c 500)
	printf '%s\n' "$claudeError" >&2
	[ -f "$OUT" ] || writeEmptyRecord
	exit 5
fi

# Strip any stray markdown code fences the model may have added, then drop any leading
# blank lines so the opening brace lands on the first line for the inject step below.
result=$(printf '%s\n' "$result" | sed '/^[[:space:]]*```/d' | sed '/./,$!d')

# Accept only output that actually looks like the requested JSON object. Only the first
# line is checked: `cut` works per line, and the reply may be pretty-printed.
firstChar=$(printf '%s\n' "$result" | head -n1 | sed -e 's/^[[:space:]]*//' | cut -c1)
if [ "$firstChar" != "{" ]; then
	echo "generateDimDiagram: Claude output unusable for $REL; leaving as raw."
	[ -f "$OUT" ] || writeEmptyRecord
	exit 6
fi

progress saving

# Wrap the model's object into the record by injecting our fields right after its
# opening brace, keeping the model's "readme", "tests" and "diagrams" fields intact. Only the
# first "{" (the object opener) on line 1 is touched, so a brace anywhere inside the
# readme text is left alone. `$REL`/`$srcHash` contain no JSON-special characters; the
# `|` delimiter avoids the "/" in relative paths.
# A test file's record must always carry a "tests" field, or the freshness check above
# would regenerate it on every open; add an empty one when the model left it out.
testsField=""
if [ "$isTestFile" = 1 ] && ! printf '%s' "$result" | grep -q '"tests"[[:space:]]*:'; then
	testsField=' "tests": [],'
fi
# A file with changes is stamped with the commit they are measured against, which tells
# the editor when they have been committed (see the header). `$baseSha` is plain hex.
# Changes waiting for review are stamped with the staged blob instead, and no commit:
# committing does not settle them, accepting or rejecting them does.
diffField=""
diffBase="\"base\": \"$baseSha\""
[ -n "$pendingHash" ] && diffBase="\"pending\": \"$pendingHash\""
case "$diffState" in
	changed)
		# A test file's stamp also says its tests are marked (see the freshness check above).
		diffTests=""
		[ "$isTestFile" = 1 ] && diffTests=", \"tests\": true"
		diffField=" \"diff\": {$diffBase, \"new\": false$diffTests},"
		;;
	new) diffField=" \"diff\": {$diffBase, \"new\": true}," ;;
esac
tmp="$OUT.tmp.$$"
printf '%s\n' "$result" \
	| sed "1 s|{|{\"version\": 1, \"source\": \"$REL\", \"sourceHash\": \"$srcHash\",$diffField$testsField|" \
	> "$tmp" && mv "$tmp" "$OUT"
echo "generateDimDiagram: generated diagram and overview for $REL"

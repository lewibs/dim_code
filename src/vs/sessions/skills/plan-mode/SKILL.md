---
name: plan-mode
description: Plan a code change as a live Dim diagram before touching any code. Use when the user asks to plan, design or sketch a change first, says "plan mode", "don't change anything yet", "show me what you'd change", or wants to agree on the approach before edits. Keeps a plan record in .dim/big_picture/plans/ whose diagrams color the files and pieces that will be added, changed or removed, updates it as the user describes the work, and makes no code changes until the user approves.
---

# Plan mode in Dim

In plan mode you don't change the code. You draw the change instead. You keep a **plan record**: a Dim big-picture record whose diagrams show the part of the architecture the change touches, colored by what the change will do to it. As the user says what they want, you redraw it. When the user approves the plan, you make the edits.

Read the `big-picture` skill for the record format and how to open it, and the `diagram-writing` skill (its "Showing changes" section especially) for how to draw and mark changes.

## Start a plan

1. Read the code the change will touch: the files it edits and the files around them that the reader needs to see where the change fits.
2. Write the plan record to `<workspaceFolder>/.dim/big_picture/plans/<topic-slug>.dim`. It is a big-picture record with one extra top-level field:

   ```json
   {
   	"version": 1,
   	"plan": { "status": "planning", "request": "What the user asked for, in one sentence." },
   	"readme": "…",
   	"diagrams": [ … ]
   }
   ```

   While `plan.status` is `planning`, Dim blocks edits to the workspace's files (everything outside `.dim/`). That is what keeps the code untouched until the user agrees.
3. Check the JSON is valid (`python3 -m json.tool <file>`), then open the record with `dim_open` from the `open-files` skill. Open it once. The viewer redraws by itself every time you rewrite the file.

## Draw the change

- **Diagrams.** Usually one Structure diagram (`classDiagram`) of the files or classes involved and how they depend on each other. Add a Behavior diagram (`sequenceDiagram`) when the change is about a flow: a new call path, a new message, a reordered step. Draw the architecture **as it will be after the change**, plus enough of its unchanged surroundings to show where the change fits. Draw a box per file when the change spans many files, and a box per class or function when it stays inside a few.
- **Colors.** Give each diagram a `changes` list, as in the `diagram-writing` skill's "Showing changes" section:
  - `added`: files, classes, functions, members, calls or edges the plan creates.
  - `changed`: existing ones the plan modifies. Mark the most specific element (`Box.method`, not the whole box).
  - `removed`: existing ones the plan deletes. Keep them drawn as they are today, wrapped in `%% dim:removed` / `%% dim:end` lines.
  - Everything else stays unmarked, so the reader sees at a glance what moves and what doesn't.
- **Links.** Add a link for every element that exists in the code **today**, with its real workspace-relative `file`, so the user can click it to open that file. Give `line`/`endLine` when the plan touches a specific part of an existing file, so the click lands there. Don't link elements that don't exist yet (new files, new functions): there's nothing to open.
- **README.** Plain text. Start with the request and the current status ("Planning: nothing has been changed yet."). Then say how the change works in a few short paragraphs. End with a "Files:" list, one workspace-relative path per line, each tagged `(new)`, `(edit)` or `(delete)` with a few words on what happens to it. If anything is undecided, end with an "Open questions:" list.

Every existing name and path in the record must be real. Read the code; don't guess.

## Each turn while planning

When the user adds, changes or drops part of the plan:

1. Rewrite the plan record so the diagrams, colors, links and README describe the plan as it now stands. Rewrite the whole file. Don't append a history of revisions.
2. Check the JSON is valid. Don't reopen the record; the viewer is already showing it.
3. Reply briefly: what changed in the plan, and any question you need answered. Don't repeat the README.

Stay in plan mode until the user approves. While planning:

- Don't edit, create, move or delete any file outside `.dim/`, and don't run commands that do (no `sed -i`, formatters, code generators, `npm install`, `git commit`, `git checkout`, and so on). The gate blocks the file-editing tools, but not shell commands, so this is on you.
- Reading, searching and running read-only commands (`git log`, `git diff`, `grep`, tests that write nothing) is fine.

## Approve, implement, cancel

- **Approval** has to be clear, for example "go", "do it", "approved", "implement it". A question or a further change isn't approval. On approval, set `plan.status` to `approved` and the README status line to "Approved: being implemented.", then make the changes the plan describes. Keep to the plan. If the code makes you change course, stop, put the record back to `planning` with the new approach drawn, and ask.
- **When the work is done**, set `plan.status` to `done` and the README status line to "Done.". Leave the diagrams as they are. Each file's own Dim view now shows its real changes.
- **If the user drops the plan**, set `plan.status` to `abandoned`. Never leave a dropped plan on `planning`, because it would keep blocking edits.

Only one plan should be `planning` at a time. Before starting a new plan, list `.dim/big_picture/plans/`. If one is still `planning`, ask the user whether to continue it or drop it.

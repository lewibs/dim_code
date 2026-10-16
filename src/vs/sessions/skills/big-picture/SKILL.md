---
name: big-picture
description: Answer questions about how code spanning several files works with a Dim big-picture diagram. Use whenever the user asks how a feature, flow, system or set of components works, fits together, manages or handles something, or asks you to "show me", "walk me through" or "explain" one, and the answer could be shown as a diagram (architecture, call flow, data flow, lifecycle, states), but no single file explains it well. Also use it when the user is debugging a problem that crosses components (state falling out of sync, messages not arriving, a cache going stale) and wants to understand the flow before fixing it. Writes a .dim record to .dim/big_picture/ and opens it for the user.
---

# Big-picture diagrams in Dim

Dim gives every source file its own `.dim` record (an overview and diagrams of that one file). Some questions don't fit in one file: "how does a chat request reach the model?", "how do the extension host and the workbench talk?", "what happens when a session starts?". For those, write a **big-picture record**: a `.dim` file in the workspace's `.dim/big_picture/` folder that Dim opens in its diagram viewer, with a README and one or more diagrams.

## When to make one

Make one only if both of these are true:

1. The user is asking how something works, fits together or flows, and the answer could be shown as a diagram of any kind (structure, sequence, flowchart, states, data).
2. No single existing file answers it well. If one file does (for example a service that owns the whole flow, or an existing doc with a diagram), **don't** make a big picture. Open that file for the user instead (see the `open-files` skill). Its own Dim view already shows its diagrams.

The question doesn't have to say "how does X work". These all count:

- "Show me how X manages / handles / tracks Y."
- "Walk me through what happens when…"
- "Why does X keep falling out of sync with Y? I want to look into it." A debugging question about several components is a request to understand the flow first. Answer it with a big picture of the flow, and put the suspected causes in the README and your reply.
- Any question whose answer you would explain with an ASCII diagram, or a list of `file:line` references across three or more files. If you're about to draw one in chat, write the record instead.

Signs that no single file answers it: the flow crosses a process or layer boundary (workbench ↔ extension host ↔ webview, main ↔ renderer, client ↔ server), or the same state is kept in several places that have to agree.

Before writing a new record, list `.dim/big_picture/`. If a record already covers the topic, open it. Update it first if the code it describes has changed.

## Where it goes

`<workspaceFolder>/.dim/big_picture/<topic-slug>.dim`, for example `.dim/big_picture/chat-request-flow.dim`. Use a short kebab-case slug that names the topic. Subfolders are allowed for grouping (`.dim/big_picture/auth/login-flow.dim`).

If `<workspaceFolder>/.dim/` doesn't exist yet, create it with a `.gitignore` holding exactly this (Dim keeps the folder out of git by default):

```
# Dim diagram records. Turn off the "dim.diagrams.gitignore" setting to commit them with the code.
*
```

## What goes in it

The file is JSON, the same format as a per-file record, without `source` or `sourceHash`:

```json
{
	"version": 1,
	"readme": "What these diagrams show, in plain English…",
	"diagrams": [
		{
			"type": "sequenceDiagram",
			"label": "Sequence",
			"mermaid": "sequenceDiagram\n  participant View as ChatView\n  participant Service as ChatService\n  View->>Service: sendRequest(message)\n  …",
			"links": [
				{ "label": "View", "symbol": "ChatView", "kind": "class", "file": "src/vs/workbench/contrib/chat/browser/chatView.ts" },
				{ "label": "Service", "symbol": "ChatService", "kind": "class", "file": "src/vs/workbench/contrib/chat/common/chatService.ts" },
				{ "label": "sendRequest(message)", "symbol": "ChatService.sendRequest", "kind": "function", "file": "src/vs/workbench/contrib/chat/common/chatService.ts" }
			]
		}
	]
}
```

- **`readme`**: plain text, not Markdown. It's shown as written, with line breaks kept. Say what question the record answers and what each diagram shows. Then walk through the flow or structure in a few short paragraphs, naming the real classes and functions. End with a "Files:" list of the workspace-relative paths involved, one per line, each with a few words on its role.
- **`diagrams`**: as many as genuinely help, usually one or two. Each needs a `type` (one of `classDiagram`, `sequenceDiagram`, `flowchart`, `stateDiagram`, `erDiagram`), a `label` (`Structure`, `Sequence`, `Logic`, `States` or `Data`, matching the type), and `mermaid` source. Pick the kind and draw it following the `diagram-writing` skill and its per-kind files. Use the code's real identifiers.
- **`links`**: these are what make the diagram useful across files. Add an entry for every box, participant and call drawn, each with its workspace-relative `file`, so a click opens that file's own Dim view. `kind` is `class`, `function`, `attribute` or `file` (use `file` for a box that stands for a whole module). A link can also name the `view` it opens on (`readme`, a diagram type, or `raw`) and, with `line` and `endLine`, the exact lines it points at, which open raw with those lines selected. See the `diagram-writing` skill's links section.

Read the code before you draw. Every name in the diagram must exist, and every `file` must be a real path. Check that the JSON is valid (for example with `python3 -m json.tool <file>`) before opening it.

## Show it to the user

Open the record in Dim with `dim_open` from the `open-files` skill, giving it the record's absolute path. It opens in the diagram viewer on its README, and the editor-title picker switches between the README and the diagrams. In your reply, give a short answer and point to the record and the key files with `path:line` references. Don't repeat the whole README.

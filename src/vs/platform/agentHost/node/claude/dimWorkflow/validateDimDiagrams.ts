/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that the diagrams in a Dim generator reply build: that the reply is the JSON
// object the generator asked for and that Mermaid can parse every diagram's source.
// Run by generateDimDiagram.sh once Claude has answered, so a diagram that would only
// show "Syntax error" in the viewer is caught (and sent back to Claude to fix) before
// it is saved. It also flags a reply with no diagrams, a diagram with no links, a link to
// a file that does not exist and a change naming nothing the diagram draws, so Claude is
// asked to correct them; such a diagram builds, so it is kept either way.
//
// Usage: node validateDimDiagrams.js <node_modules dir holding mermaid> [workspace folder] < reply.json
// Links are only checked against the workspace when its folder is given.
//
// Exit status, a contract with generateDimDiagram.sh:
//   0  the reply is valid JSON and every diagram parses
//   1  some diagrams do not parse, or something is missing or wrong; stdout is the reply without
//      the diagrams that do not parse (one line of JSON), stderr names each problem
//   2  could not check (Mermaid could not be loaded); the reply should be kept as it is
//   3  the reply is not valid JSON; stderr holds the parse error

import { access } from 'fs/promises';
import { pathToFileURL } from 'url';

/** The part of a link or change in the reply that is checked. */
interface IReplyElement {
	readonly label?: unknown;
	readonly file?: unknown;
}

/** The part of a diagram in the reply that is checked. */
interface IReplyDiagram {
	readonly type?: string;
	readonly label?: string;
	readonly mermaid?: string;
	readonly links?: readonly IReplyElement[];
	readonly changes?: readonly IReplyElement[];
}

/** The reply's JSON object; only its diagrams are checked, the rest is passed through. */
interface IReply {
	readonly diagrams?: readonly IReplyDiagram[];
}

/** The Mermaid API used here. */
interface IMermaid {
	parse(text: string): Promise<unknown>;
}

/** The DOMPurify methods Mermaid calls while it loads and parses. */
interface IPurify {
	addHook?: () => void;
	removeHook?: () => void;
	removeHooks?: () => void;
	sanitize?: (text: string) => string;
}

/** Reads all of stdin as text. */
async function readStdin(): Promise<string> {
	let text = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) {
		text += chunk;
	}
	return text;
}

/** Loads Mermaid from the given node_modules folder, set up to parse in Node. */
async function loadMermaid(modulesDir: string): Promise<IMermaid> {
	// Mermaid sanitizes labels with DOMPurify, which needs a DOM to set itself up and is
	// left without its methods in Node. Parsing never sanitizes anything that matters
	// here, so stub them on the shared module instance before Mermaid reads them.
	const modulesUrl = pathToFileURL(modulesDir + '/');
	const purify: IPurify = (await import(new URL('dompurify/dist/purify.es.mjs', modulesUrl).href)).default;
	purify.addHook ??= () => { };
	purify.removeHook ??= () => { };
	purify.removeHooks ??= () => { };
	purify.sanitize ??= text => text;
	return (await import(new URL('mermaid/dist/mermaid.core.mjs', modulesUrl).href)).default;
}

/** Names what is wrong with a diagram that builds: missing links, links to files that do not exist and changes that name nothing drawn. */
async function checkElements(name: string, diagram: IReplyDiagram, workspace: string | undefined): Promise<string[]> {
	const errors: string[] = [];
	const links = Array.isArray(diagram.links) ? diagram.links : [];
	if (links.length === 0) {
		errors.push(`${name}: it has no "links". Link every box, member, participant and message it draws to the code it stands for.`);
	}
	if (workspace) {
		const files = new Set(links.map(link => link?.file).filter((file): file is string => typeof file === 'string' && !!file));
		for (const file of files) {
			try {
				await access(file.startsWith('/') ? file : `${workspace}/${file}`);
			} catch {
				errors.push(`${name}: a link names the file "${file}", which does not exist. Give the workspace-relative path of the file that defines the symbol.`);
			}
		}
	}
	// A change is colored by its label: it must be a link's label, or at least name
	// something the source draws.
	const labels = new Set(links.map(link => link?.label));
	for (const change of Array.isArray(diagram.changes) ? diagram.changes : []) {
		const label = typeof change?.label === 'string' ? change.label : '';
		const drawn = label.split('.').pop() ?? '';
		if (!labels.has(label) && !(drawn && diagram.mermaid?.includes(drawn))) {
			errors.push(`${name}: its "changes" names "${label}", which the diagram does not draw. Name each changed element exactly as the "label" of its link.`);
		}
	}
	return errors;
}

async function main(): Promise<number> {
	const reply = await readStdin();
	const workspace = process.argv[3] || undefined;

	let record: IReply;
	try {
		record = JSON.parse(reply);
	} catch (err) {
		process.stderr.write(`The reply is not valid JSON: ${(err as Error).message}\n`);
		return 3;
	}
	if (!record || typeof record !== 'object' || Array.isArray(record)) {
		process.stderr.write('The reply is not a JSON object.\n');
		return 3;
	}

	let mermaid: IMermaid;
	try {
		mermaid = await loadMermaid(process.argv[2]);
	} catch (err) {
		process.stderr.write(`Mermaid could not be loaded from ${process.argv[2]}: ${(err as Error).message}\n`);
		return 2;
	}

	const valid: IReplyDiagram[] = [];
	const errors: string[] = [];
	const diagrams = Array.isArray(record.diagrams) ? record.diagrams : [];
	if (diagrams.length === 0) {
		errors.push('The reply has no diagrams. Draw every kind of diagram that applies to the code.');
	}
	for (const diagram of diagrams) {
		const name = `${diagram?.label ?? '?'} (${diagram?.type ?? '?'})`;
		if (typeof diagram?.mermaid !== 'string' || !diagram.mermaid.trim()) {
			errors.push(`${name}: it has no "mermaid" source.`);
			continue;
		}
		try {
			await mermaid.parse(diagram.mermaid);
			valid.push(diagram);
			errors.push(...await checkElements(name, diagram, workspace));
		} catch (err) {
			// Mermaid's parse errors span several lines (the position, a caret, what it
			// expected); keep them whole but bounded.
			errors.push(`${name}: ${String((err as Error)?.message ?? err).slice(0, 800)}`);
		}
	}

	if (errors.length === 0) {
		return 0;
	}
	process.stderr.write(errors.join('\n') + '\n');
	process.stdout.write(JSON.stringify({ ...record, diagrams: valid }) + '\n');
	return 1;
}

// Set the exit code rather than exiting, so the filtered reply is fully written first.
main().then(code => process.exitCode = code, err => {
	process.stderr.write(`${err}\n`);
	process.exitCode = 2;
});

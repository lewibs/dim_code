/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that the diagrams in a Dim generator reply build: that the reply is the JSON
// object the generator asked for and that Mermaid can parse every diagram's source.
// Run by generateDimDiagram.sh once Claude has answered, so a diagram that would only
// show "Syntax error" in the viewer is caught (and sent back to Claude to fix) before
// it is saved.
//
// Usage: node validateDimDiagrams.js <node_modules dir holding mermaid> < reply.json
//
// Exit status, a contract with generateDimDiagram.sh:
//   0  the reply is valid JSON and every diagram parses
//   1  some diagrams do not parse; stdout is the reply without them (one line of JSON),
//      stderr names each one with Mermaid's error
//   2  could not check (Mermaid could not be loaded); the reply should be kept as it is
//   3  the reply is not valid JSON; stderr holds the parse error

import { pathToFileURL } from 'url';

/** The part of a diagram in the reply that is checked. */
interface IReplyDiagram {
	readonly type?: string;
	readonly label?: string;
	readonly mermaid?: string;
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

async function main(): Promise<number> {
	const reply = await readStdin();

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
	for (const diagram of Array.isArray(record.diagrams) ? record.diagrams : []) {
		const name = `${diagram?.label ?? '?'} (${diagram?.type ?? '?'})`;
		if (typeof diagram?.mermaid !== 'string' || !diagram.mermaid.trim()) {
			errors.push(`${name}: it has no "mermaid" source.`);
			continue;
		}
		try {
			await mermaid.parse(diagram.mermaid);
			valid.push(diagram);
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { MermaidConfig } from 'mermaid';

const svgNamespace = 'http://www.w3.org/2000/svg';

/** The corner radius of a diagram card, matching the editor's widgets. */
const cardRadius = 8;

/**
 * Adds the Dim editor's layout settings to a mermaid config: the ELK layout engine
 * (for class, flowchart, state and ER diagrams; sequence diagrams lay themselves out)
 * and a little more room between boxes so their edge labels can breathe.
 */
export function withDimDiagramLayout(config: MermaidConfig): MermaidConfig {
	return {
		...config,
		layout: 'elk',
		elk: {
			nodePlacementStrategy: 'BRANDES_KOEPF',
			mergeEdges: false,
		},
		flowchart: { ...config.flowchart, curve: 'rounded', nodeSpacing: 48, rankSpacing: 56, padding: 12 },
		class: { ...config.class, padding: 10 },
		sequence: { ...config.sequence, actorMargin: 64, boxMargin: 12, noteMargin: 12, messageMargin: 40, mirrorActors: false },
	};
}

/**
 * Restyles a rendered diagram's rectangular boxes as rounded cards. Mermaid draws
 * class, entity and flowchart boxes as paths, which CSS cannot round, so each square
 * box outline is swapped for a rounded `rect.dim-card` of the same size. Boxes that
 * are not rectangles (decisions, start and end markers, already rounded states) are
 * left as mermaid drew them.
 */
export function roundDiagramBoxes(root: HTMLElement): void {
	const svg = root.querySelector('svg');
	if (!svg) {
		return;
	}
	for (const outline of svg.querySelectorAll<SVGGElement>('g.node > g.outer-path, g.node > g.label-container')) {
		const shape = outline.querySelector<SVGGeometryElement>('path, rect, polygon');
		if (!shape || !isSquareBox(shape)) {
			continue;
		}
		const box = outline.getBBox();
		const card = document.createElementNS(svgNamespace, 'rect');
		card.setAttribute('class', 'dim-card');
		card.setAttribute('x', String(box.x));
		card.setAttribute('y', String(box.y));
		card.setAttribute('width', String(box.width));
		card.setAttribute('height', String(box.height));
		card.setAttribute('rx', String(cardRadius));
		outline.before(card);
		outline.classList.add('dim-card-replaced');
	}
}

/** Whether a shape fills all four corners of its bounding box, i.e. it is a square-cornered box. */
function isSquareBox(shape: SVGGeometryElement): boolean {
	const box = shape.getBBox();
	if (box.width < 4 * cardRadius || box.height < 2 * cardRadius) {
		return false;
	}
	const inset = 1.5;
	const corners = [
		{ x: box.x + inset, y: box.y + inset },
		{ x: box.x + box.width - inset, y: box.y + inset },
		{ x: box.x + inset, y: box.y + box.height - inset },
		{ x: box.x + box.width - inset, y: box.y + box.height - inset },
	];
	return corners.every(corner => shape.isPointInFill(corner));
}

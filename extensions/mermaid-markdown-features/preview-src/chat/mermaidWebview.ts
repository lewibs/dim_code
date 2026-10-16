/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import mermaid from 'mermaid';
import { buildMermaidConfig, createMermaidErrorElement, loadExtensionConfig, markVsCodeContextAsError } from '../shared';
import { VsCodeMermaidThemeTracker } from '../shared/vsCodeTheme';
import { DimChange, DimNavigate, enhanceDiagramClickability, markDiagramChanges } from './dimClickable';
import { VsCodeApi } from './vscodeApi';

interface PanZoomState {
	readonly scale: number;
	readonly translateX: number;
	readonly translateY: number;
}

interface PanZoomOptions {
	readonly defaultView?: 'center' | 'fit';
}

interface Size {
	readonly width: number;
	readonly height: number;
}

export class PanZoomHandler {
	private scale = 1;
	private fitScale = 1;
	private translateX = 0;
	private translateY = 0;
	private readonly resizeObserver: ResizeObserver;

	private isPanning = false;
	private hasDragged = false;
	private hasInteracted = false;
	private panModeEnabled = false;
	private startX = 0;
	private startY = 0;

	private readonly minScale = 0.1;
	private readonly maxScale = 5;
	private readonly zoomFactor = 0.002;
	private readonly fitPadding = 16;

	constructor(
		private readonly container: HTMLElement,
		private readonly content: HTMLElement,
		private readonly vscode: VsCodeApi,
		private readonly options: PanZoomOptions = {}
	) {
		this.container = container;
		this.content = content;
		this.content.style.transformOrigin = '0 0';
		this.container.style.overflow = 'hidden';
		this.container.style.cursor = 'default';
		this.setupEventListeners();

		// Chat output containers can resize without triggering a window resize event.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);
		window.addEventListener('pagehide', () => this.resizeObserver.disconnect(), { once: true });
	}

	/**
	 * Initializes the pan/zoom state - either restores from saved state or applies the default view.
	 */
	public initialize(): void {
		if (!this.restoreState()) {
			// Use requestAnimationFrame to ensure layout is updated before resetting the view
			requestAnimationFrame(() => {
				this.resetView();
			});
		}
	}

	private setupEventListeners(): void {
		// Pan with mouse drag
		this.container.addEventListener('mousedown', e => this.handleMouseDown(e));
		document.addEventListener('mousemove', e => this.handleMouseMove(e));
		document.addEventListener('mouseup', () => this.handleMouseUp());

		// Click to zoom (Alt+click = zoom in, Alt+Shift+click = zoom out)
		this.container.addEventListener('click', e => this.handleClick(e));

		// Wheel, trackpad scroll and pinch all zoom (see handleWheel).
		this.container.addEventListener('wheel', e => this.handleWheel(e), { passive: false });

		// Update cursor when Alt/Option key is pressed
		this.container.addEventListener('mousemove', e => this.updateCursorFromModifier(e));
		this.container.addEventListener('mouseenter', e => this.updateCursorFromModifier(e));
		window.addEventListener('keydown', e => this.handleKeyChange(e));
		window.addEventListener('keyup', e => this.handleKeyChange(e));
	}

	private handleKeyChange(e: KeyboardEvent): void {
		if ((e.key === 'Alt' || e.key === 'Shift') && !this.isPanning) {
			e.preventDefault();
			this.setCursor(e.altKey, e.shiftKey);
		}
	}

	private updateCursorFromModifier(e: MouseEvent): void {
		if (this.isPanning) {
			return;
		}
		this.setCursor(e.altKey, e.shiftKey);
	}

	private setCursor(altKey: boolean, shiftKey: boolean): void {
		if (this.panModeEnabled) {
			this.container.style.cursor = 'grab';
			return;
		}

		if (altKey && shiftKey) {
			this.container.style.cursor = 'zoom-out';
		} else if (altKey) {
			this.container.style.cursor = 'zoom-in';
		} else {
			// Left-click drag always pans, so grab is the resting cursor.
			this.container.style.cursor = 'grab';
		}
	}

	private handleClick(e: MouseEvent): void {
		// Only zoom on click if Alt is held and we didn't drag
		if (!e.altKey || this.hasDragged) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		const rect = this.container.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		// Alt+Shift+click = zoom out, Alt+click = zoom in
		const factor = e.shiftKey ? 0.8 : 1.25;
		this.zoomAtPoint(factor, x, y);
	}

	private handleWheel(e: WheelEvent): void {
		// The diagram fills the viewport, so there is nothing to scroll past:
		// the wheel, a trackpad two-finger scroll and a pinch gesture all zoom.
		// ctrlKey is set by browsers for pinch-to-zoom gestures.
		const isPinchZoom = e.ctrlKey;

		e.preventDefault();
		e.stopPropagation();

		const rect = this.container.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		const mouseY = e.clientY - rect.top;

		// Calculate zoom (scroll up = zoom in, scroll down = zoom out).
		// Pinch gestures have smaller deltaY values, so use a higher factor.
		const effectiveZoomFactor = isPinchZoom ? this.zoomFactor * 5 : this.zoomFactor;
		const delta = -e.deltaY * effectiveZoomFactor;
		const newScale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * (1 + delta)));

		// Zoom toward the pointer position.
		const scaleFactor = newScale / this.scale;
		this.translateX = mouseX - (mouseX - this.translateX) * scaleFactor;
		this.translateY = mouseY - (mouseY - this.translateY) * scaleFactor;
		this.scale = newScale;

		this.applyTransform();
		this.saveState();
	}

	private handleMouseDown(e: MouseEvent): void {
		// Left-click drag always pans.
		if (e.button !== 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.isPanning = true;
		this.hasDragged = false;
		this.startX = e.clientX - this.translateX;
		this.startY = e.clientY - this.translateY;
		this.container.style.cursor = 'grabbing';
	}

	private handleMouseMove(e: MouseEvent): void {
		if (!this.isPanning) {
			return;
		}

		// Handle case where mouse was released outside the webview
		if (e.buttons === 0) {
			this.handleMouseUp();
			return;
		}

		const dx = e.clientX - this.startX - this.translateX;
		const dy = e.clientY - this.startY - this.translateY;
		if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
			this.hasDragged = true;
		}
		this.translateX = e.clientX - this.startX;
		this.translateY = e.clientY - this.startY;
		this.applyTransform();
	}

	private handleMouseUp(): void {
		if (this.isPanning) {
			this.isPanning = false;
			this.setCursor(false, false);
			this.saveState();
		}
	}

	private applyTransform(): void {
		this.content.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
	}

	private saveState(): void {
		this.hasInteracted = true;
		const currentState = this.vscode.getState() || {};
		this.vscode.setState({
			...currentState,
			panZoom: {
				scale: this.scale,
				translateX: this.translateX,
				translateY: this.translateY
			}
		});
	}

	private restoreState(): boolean {
		const state = this.vscode.getState();
		if (state?.panZoom) {
			const panZoom = state.panZoom as PanZoomState;
			this.updateFitScale();
			this.scale = panZoom.scale ?? 1;
			this.translateX = panZoom.translateX ?? 0;
			this.translateY = panZoom.translateY ?? 0;
			this.hasInteracted = true;
			this.applyTransform();
			return true;
		}
		return false;
	}

	private handleResize(): void {
		this.updateFitScale();
		if (!this.hasInteracted) {
			this.resetView();
		}
	}

	private updateFitScale(): void {
		if (this.options.defaultView !== 'fit') {
			this.fitScale = 1;
			return;
		}

		const scale = this.getScaleToFitContainer();
		if (scale !== undefined) {
			this.fitScale = scale;
		}
	}

	private getSvgSize(): Size | undefined {
		// Get the SVG element inside the content - mermaid renders to an SVG
		const svg = this.content.querySelector('svg');
		if (!svg) {
			return;
		}

		const oldTransform = this.content.style.transform;
		this.content.style.transform = 'none';
		const svgRect = svg.getBoundingClientRect();
		this.content.style.transform = oldTransform;

		if (svgRect.width <= 0 || svgRect.height <= 0) {
			return;
		}

		return { width: svgRect.width, height: svgRect.height };
	}

	private resetView(): void {
		if (this.options.defaultView === 'fit') {
			this.fitContentToContainer();
		} else {
			this.centerContent();
		}
	}

	private centerContent(): void {
		const containerRect = this.container.getBoundingClientRect();
		const svgSize = this.getSvgSize();
		if (!svgSize) {
			return;
		}

		this.scale = 1;
		this.fitScale = 1;
		this.translateX = (containerRect.width - svgSize.width) / 2;
		this.translateY = (containerRect.height - svgSize.height) / 2;

		this.applyTransform();
	}

	private fitContentToContainer(): void {
		const svgSize = this.getSvgSize();
		if (!svgSize) {
			return;
		}

		const containerRect = this.container.getBoundingClientRect();
		this.scale = this.getScaleToFitContainer(svgSize, containerRect) ?? 1;
		this.fitScale = this.scale;
		this.translateX = (containerRect.width - (svgSize.width * this.scale)) / 2;
		this.translateY = (containerRect.height - (svgSize.height * this.scale)) / 2;

		this.applyTransform();
	}

	private getScaleToFitContainer(svgSize = this.getSvgSize(), containerRect = this.container.getBoundingClientRect()): number | undefined {
		if (!svgSize) {
			return;
		}

		const availableWidth = Math.max(1, containerRect.width - (this.fitPadding * 2));
		const availableHeight = Math.max(1, containerRect.height - (this.fitPadding * 2));
		const scale = Math.min(1, availableWidth / svgSize.width, availableHeight / svgSize.height);
		return Number.isFinite(scale) && scale > 0 ? scale : undefined;
	}

	public reset(): void {
		this.scale = 1;
		this.translateX = 0;
		this.translateY = 0;
		this.hasInteracted = false;
		this.applyTransform(); // Apply scale first so content size is correct

		// Clear the saved pan/zoom state
		const currentState = this.vscode.getState() || {};
		delete currentState.panZoom;
		this.vscode.setState(currentState);

		// Use requestAnimationFrame to ensure layout is updated before resetting the view
		requestAnimationFrame(() => {
			this.resetView();
		});
	}

	public zoomIn(): void {
		const rect = this.container.getBoundingClientRect();
		this.zoomAtPoint(1.25, rect.width / 2, rect.height / 2);
	}

	public zoomOut(): void {
		const rect = this.container.getBoundingClientRect();
		this.zoomAtPoint(0.8, rect.width / 2, rect.height / 2);
	}

	public togglePanMode(): boolean {
		this.panModeEnabled = !this.panModeEnabled;
		this.setCursor(false, false);
		return this.panModeEnabled;
	}

	/**
	 * Whether the most recent pointer gesture was a drag (a pan) rather than a clean
	 * click. Stays set until the next `mousedown`, so a click handler firing right after
	 * a pan can tell the two apart and avoid treating the end of a pan as a click.
	 */
	public didJustDrag(): boolean {
		return this.hasDragged;
	}

	private zoomAtPoint(factor: number, x: number, y: number): void {
		const minAllowedScale = Math.min(this.minScale, this.fitScale, this.scale);
		const newScale = Math.min(this.maxScale, Math.max(minAllowedScale, this.scale * factor));
		const scaleFactor = newScale / this.scale;
		this.translateX = x - (x - this.translateX) * scaleFactor;
		this.translateY = y - (y - this.translateY) * scaleFactor;
		this.scale = newScale;
		this.applyTransform();
		this.saveState();
	}
}

/**
 * Unpersisted state
 */
interface LocalState {
	// Mutable: the diagram toggle updates this so a later theme-change re-render
	// reuses the currently selected diagram's source.
	mermaidSource: string;
}

interface PersistedState {
	readonly mermaidSource: string;
	readonly panZoom?: PanZoomState;
}

/**
 * Re-renders the mermaid diagram when theme changes
 */
async function rerenderMermaidDiagram(
	diagramElement: HTMLElement,
	diagramText: string,
	themeTracker: VsCodeMermaidThemeTracker,
): Promise<void> {
	diagramElement.textContent = diagramText;
	delete diagramElement.dataset.processed;

	mermaid.initialize(buildMermaidConfig(loadExtensionConfig(), themeTracker));
	await mermaid.run({
		nodes: [diagramElement]
	});
}

/**
 * Reads the record's views from the `#dim-views` JSON data block embedded in the
 * webview HTML. Each view is either a mermaid diagram (`mermaid` set) or the README
 * overview (`text` set). The native Dim view toggle (in the editor title bar)
 * switches between these by index via a `dimSelectDiagram` message. Returns an empty
 * array when the block is absent or malformed.
 */
function readDimViews(): Array<{ mermaid?: string; text?: string; placeholder?: boolean; changes?: DimChange[]; isNew?: boolean }> {
	const dataElement = document.getElementById('dim-views');
	if (!dataElement) {
		return [];
	}
	try {
		const parsed = JSON.parse(dataElement.textContent ?? '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * The README view's generation status banner. Mirrors `IDimStatusBanner` in the
 * extension's `editorManager.ts`; keep the two in sync.
 */
interface DimStatusBanner {
	readonly kind: 'running' | 'failed';
	readonly message: string;
	readonly detail?: string;
	readonly steps?: ReadonlyArray<{ readonly label: string; readonly state: DimStepState }>;
	readonly startedAt?: number;
	readonly elapsedLabel?: string;
}

type DimStepState = 'done' | 'current' | 'pending';

/** Codicon classes for each banner kind; mirrors the icon the extension renders initially. */
const dimStatusIconClasses: Record<DimStatusBanner['kind'], readonly string[]> = {
	running: ['codicon-loading', 'codicon-modifier-spin'],
	failed: ['codicon-error'],
};

/**
 * Codicon classes for a step's state. Mirrors `dimStepIconClasses` in the extension's
 * `editorManager.ts`; keep the two in sync.
 */
const dimStepIconClasses: Record<DimStepState, readonly string[]> = {
	done: ['codicon-check'],
	current: ['codicon-loading', 'codicon-modifier-spin'],
	pending: ['codicon-circle-large-outline'],
};

/**
 * Refreshes the banner's elapsed-time text from its `data-started-at` and
 * `data-elapsed-label` attributes; clears it when the banner has no running timer.
 */
function updateDimStatusElapsed(): void {
	const banner = document.querySelector<HTMLElement>('.dim-status');
	const elapsed = banner?.querySelector<HTMLElement>('.dim-status-elapsed');
	if (!banner || !elapsed) {
		return;
	}
	const startedAt = Number(banner.dataset.startedAt);
	const label = banner.dataset.elapsedLabel;
	elapsed.textContent = !banner.hidden && label && Number.isFinite(startedAt)
		? label.replace('{0}', String(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))))
		: '';
}

/**
 * Shows (or, with `undefined`, hides) the README's generation status banner in place.
 * The banner exists in the page whether or not the README is the shown view, so an
 * update while a diagram shows is visible as soon as the README is selected.
 */
function applyDimStatus(status: DimStatusBanner | undefined): void {
	const banner = document.querySelector<HTMLElement>('.dim-status');
	if (!banner) {
		return;
	}
	banner.hidden = !status;
	if (status?.startedAt !== undefined && status.elapsedLabel) {
		banner.dataset.startedAt = String(status.startedAt);
		banner.dataset.elapsedLabel = status.elapsedLabel;
	} else {
		delete banner.dataset.startedAt;
		delete banner.dataset.elapsedLabel;
	}
	updateDimStatusElapsed();
	if (!status) {
		return;
	}
	banner.dataset.kind = status.kind;
	const steps = banner.querySelector<HTMLElement>('.dim-status-steps');
	if (steps) {
		steps.replaceChildren(...(status.steps ?? []).map(step => {
			const item = document.createElement('li');
			item.dataset.state = step.state;
			const stepIcon = document.createElement('i');
			stepIcon.className = 'codicon';
			stepIcon.classList.add(...dimStepIconClasses[step.state]);
			stepIcon.setAttribute('aria-hidden', 'true');
			const text = document.createElement('span');
			text.textContent = step.label;
			item.append(stepIcon, text);
			return item;
		}));
	}
	const icon = banner.querySelector<HTMLElement>('.codicon');
	if (icon) {
		icon.classList.remove(...dimStatusIconClasses.running, ...dimStatusIconClasses.failed);
		icon.classList.add(...dimStatusIconClasses[status.kind]);
	}
	const message = banner.querySelector<HTMLElement>('.dim-status-message');
	if (message) {
		message.textContent = status.message;
	}
	const detail = banner.querySelector<HTMLElement>('.dim-status-detail');
	if (detail) {
		detail.textContent = status.detail ?? '';
	}
}

export async function initializeMermaidWebview(vscode: VsCodeApi, options?: PanZoomOptions): Promise<PanZoomHandler | undefined> {
	// The review bar's Accept All / Reject All accept every change in the workspace and reject this file's. Both stay
	// disabled from a click until the extension reports the file's review state again.
	const reviewBar = document.querySelector<HTMLElement>('.dim-review');
	const reviewButtons = Array.from(reviewBar?.querySelectorAll<HTMLButtonElement>('button') ?? []);
	for (const button of reviewButtons) {
		button.addEventListener('click', () => {
			for (const other of reviewButtons) {
				other.disabled = true;
			}
			vscode.postMessage({ type: 'dimReview', accept: button.dataset.accept === 'true' });
		});
	}

	// Generation progress and the review state can change at any moment, including while
	// the first diagram renders below, so listen for them before anything is awaited.
	window.addEventListener('message', event => {
		if (event.data?.type === 'dimStatus') {
			applyDimStatus(event.data.status);
		} else if (event.data?.type === 'dimReview' && reviewBar) {
			reviewBar.hidden = !event.data.pending;
			for (const button of reviewButtons) {
				button.disabled = false;
			}
		}
	});
	// Tick the running banner's elapsed time while Claude works. The webview is torn
	// down with the page, which ends the timer.
	if (document.querySelector('.dim-status')) {
		setInterval(updateDimStatusElapsed, 1000);
	}

	const diagram = document.querySelector<HTMLElement>('.mermaid');
	if (!diagram) {
		return;
	}

	// Capture diagram state
	const diagramText = diagram.textContent ?? '';
	const themeTracker = new VsCodeMermaidThemeTracker();
	const state: LocalState = {
		mermaidSource: diagramText,
	};

	// Save the mermaid source in the webview state
	const currentState: PersistedState = vscode.getState() || {};
	vscode.setState({
		...currentState,
		mermaidSource: diagramText
	});

	// The README overview view (plain prose) lives beside the diagram and the zoom
	// controls; the Dim toggle swaps between showing the README and a diagram.
	const readmeEl = document.querySelector<HTMLElement>('.dim-readme');
	const zoomControls = Array.from(document.querySelectorAll<HTMLElement>('.zoom-controls'));
	// The HTML hides the README (inline `display: none`) when a diagram shows first,
	// and hides the zoom controls when the README shows first.
	const startsOnReadme = !!readmeEl && readmeEl.style.display !== 'none';

	// Wrap the diagram for pan/zoom support
	const wrapper = document.createElement('div');
	wrapper.className = 'mermaid-wrapper';
	wrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

	const content = document.createElement('div');
	content.className = 'mermaid-content';

	// Move the diagram into the content wrapper
	diagram.parentNode?.insertBefore(wrapper, diagram);
	content.appendChild(diagram);
	wrapper.appendChild(content);
	// Hide the diagram surface right away when the README shows first, so nothing in
	// the setup below can leave it covering the README.
	if (startsOnReadme) {
		wrapper.style.display = 'none';
	}

	mermaid.initialize(buildMermaidConfig(loadExtensionConfig(), themeTracker));

	// Only render the diagram up front when a diagram shows first; when the README
	// shows first the `.mermaid` element is empty and running mermaid on it would
	// error, so defer the first render until a diagram view is selected.
	if (!startsOnReadme) {
		try {
			await mermaid.run({ nodes: [diagram] });
		} catch (err) {
			diagram.replaceChildren(createMermaidErrorElement(err));
			markVsCodeContextAsError(document.body);
			for (const el of zoomControls) {
				el.style.display = 'none';
			}
			diagram.classList.add('rendered');
			// Still report ready, so the extension re-sends the latest status.
			vscode.postMessage({ type: 'dimReady' });
			return;
		}
		// Show the diagram now that it's rendered
		diagram.classList.add('rendered');
	}

	const panZoomHandler = new PanZoomHandler(wrapper, content, vscode, options);
	panZoomHandler.initialize();

	// In the Dim editor the diagram's boxes and member rows are clickable, each one a
	// link into the source or a companion `.dim` view; the plain mermaid preview panel
	// leaves this off. Every click posts a `dimNavigate` message the extension resolves
	// to a concrete resource. A click is routed only when the pointer did not just pan.
	const clickable = document.body.dataset.dimClickable === 'true';
	const navigate: DimNavigate = target => vscode.postMessage({ type: 'dimNavigate', target });

	// The view the page shows, so a request for it again (the extension re-sends the
	// current view once the page is ready) does not re-render it and reset pan/zoom.
	let shownIndex = Number(document.body.dataset.dimIndex ?? 0);

	// Wires the rendered diagram's click targets and colors the changes waiting for
	// review, both on the SVG mermaid just rendered.
	const enhanceDiagram = (): void => {
		if (clickable) {
			enhanceDiagramClickability(diagram, navigate, () => panZoomHandler.didJustDrag());
		}
		const shown = readDimViews()[shownIndex];
		markDiagramChanges(diagram, shown?.changes ?? [], !!shown?.isNew);
	};

	// Wire up the initial diagram (the README view has no diagram to enhance).
	if (!startsOnReadme) {
		enhanceDiagram();
	}

	// Serialize re-renders. `mermaid.run` mutates the diagram node in place and is
	// not safe to run concurrently, so overlapping requests — rapid toggle clicks,
	// or a theme change landing mid-switch — would race and leave the wrong diagram
	// shown. Chain renders and coalesce to the most recently requested source so
	// only the latest wins.
	let renderChain: Promise<void> = Promise.resolve();
	let latestSource = state.mermaidSource;
	const requestRender = (source: string): Promise<void> => {
		latestSource = source;
		renderChain = renderChain.then(async () => {
			if (latestSource !== source) {
				return; // a newer request superseded this one
			}
			// Mermaid sizes each label box from the label's on-screen size, which includes
			// the pan/zoom transform on `content`. Rendering while zoomed out would make
			// every box too narrow and cut its text off on the right, so render unscaled
			// and put the transform back afterwards (a view switch then resets it anyway).
			const transform = content.style.transform;
			content.style.transform = 'none';
			try {
				await rerenderMermaidDiagram(diagram, source, themeTracker);
			} finally {
				content.style.transform = transform;
			}
			if (latestSource === source) {
				// mermaid replaced the SVG, so re-attach the click targets and change colors.
				enhanceDiagram();
			}
		}).catch(() => { /* keep the chain alive so later renders still run */ });
		return renderChain;
	};

	// Listen for messages from the extension
	window.addEventListener('message', async event => {
		const message = event.data;
		if (message.type === 'resetPanZoom') {
			panZoomHandler.reset();
			return;
		}
		// The native Dim view toggle asks to show a different view from the record:
		// either the README overview (plain prose) or a diagram (swapped in place).
		if (message.type === 'dimSelectDiagram') {
			const selected = readDimViews()[message.index];
			if (!selected || message.index === shownIndex) {
				return;
			}
			shownIndex = message.index;
			if (typeof selected.text === 'string') {
				// Show the README overview and hide the diagram surface and its controls.
				// Only the text is swapped; the status banner above it stays as it is.
				if (readmeEl) {
					const textEl = readmeEl.querySelector<HTMLElement>('.dim-readme-text');
					if (textEl) {
						textEl.textContent = selected.text;
						textEl.classList.toggle('dim-readme-placeholder', !!selected.placeholder);
					}
					readmeEl.style.display = '';
				}
				wrapper.style.display = 'none';
				for (const el of zoomControls) {
					el.style.display = 'none';
				}
				return;
			}
			if (typeof selected.mermaid !== 'string') {
				return;
			}
			// Show a diagram: reveal the diagram surface (hidden while the README showed)
			// and render the new source in place.
			if (readmeEl) {
				readmeEl.style.display = 'none';
			}
			wrapper.style.display = '';
			for (const el of zoomControls) {
				el.style.display = '';
			}
			state.mermaidSource = selected.mermaid;
			await requestRender(selected.mermaid);
			diagram.classList.add('rendered');
			// Only reset the view if this is still the diagram that is showing, so a
			// superseded switch does not clobber the latest selection's pan/zoom.
			if (state.mermaidSource === selected.mermaid) {
				panZoomHandler.reset();
			}
		}
	});

	// Messages the extension posted while this script loaded were dropped. Now that both
	// listeners are in place, ask it to re-send the view to show and the latest status.
	vscode.postMessage({ type: 'dimReady' });

	// Re-render when the active VS Code theme changes. The tracker watches DOM mutations on the
	// body (theme class / data attributes) and the document element (inline CSS variable updates
	// from `workbench.colorCustomizations`), and only fires when the resolved colors actually
	// change.
	themeTracker.onDidChange(() => {
		// Only re-render when a diagram is actually showing; the README view has no
		// mermaid source to re-render.
		if (wrapper.style.display !== 'none') {
			requestRender(state.mermaidSource);
		}
	});
	themeTracker.observeDomChanges();

	return panZoomHandler;
}

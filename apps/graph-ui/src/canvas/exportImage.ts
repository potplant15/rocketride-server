// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// CANVAS - IMAGE EXPORT (an SVG built from the layout, and PNG from that SVG)
// =============================================================================
//
// The page is not rasterised (no DOM-to-image library, nothing that depends on how React
// Flow nests its layers): the SVG is written from what the canvas already holds - each
// node's centre, radius, colour, badge and caption, and each relationship's slot, from
// which the same geometry the edge layer draws from (graph/geometry.ts) gives its line,
// arrow and label. The picture covers the WHOLE drawing (contentBounds, plus a margin),
// not just the part in view.
//
// The canvas draws with CSS variables (`var(--rr-chart-1)`), which mean nothing once the
// SVG leaves the page, so every colour goes through a resolver first (the canvas resolves
// against its own computed style, so the export has the current theme's colours), and a
// colour that still cannot be resolved is drawn in a plain grey rather than left out.
//
// PNG is that SVG drawn into a <canvas> at twice the size, as large as a browser canvas
// can hold. It needs a browser; `buildSvg` and `pngScale` do not, and are tested in Node.
// =============================================================================

import { edgeShape } from '../graph/geometry';
import type { IEdgeSlot } from '../graph/geometry';
import type { BadgeMode } from '../graph/userData';
import { contentBounds } from './fitBounds';

// =============================================================================
// TYPES
// =============================================================================

/** One node as exported. Colours may be CSS variables; they are resolved. */
export interface IExportNode {
	id: string;
	/** Centre, in canvas units. */
	x: number;
	y: number;
	radius: number;
	fill: string;
	/** The badge's colour (readable on the fill). */
	textColor: string;
	badge: string;
	badgeMode: BadgeMode;
	caption: string;
	dim: boolean;
	stale: boolean;
	selected: boolean;
}

/** One relationship as exported. */
export interface IExportEdge {
	id: string;
	source: string;
	target: string;
	slot: IEdgeSlot;
	type: string;
	stroke: string;
	width: number;
	dashed: boolean;
	dim: boolean;
}

/** The theme colours the drawing sits on and is written in. */
export interface IExportTheme {
	background: string;
	/** Captions and relationship labels. */
	text: string;
	/** The halo around text (the panel colour, as on the canvas). */
	halo: string;
	/** The outline of a node circle. */
	border: string;
	/** The selection ring. */
	accent: string;
}

/** How to write it. */
export interface IExportOptions {
	/** Turn any CSS colour (a `var(--x)` included) into one an SVG viewer understands. */
	resolve(css: string): string;
	/** Whether relationship type labels are written (the canvas hides them on a crowded graph). */
	labels: boolean;
	/** Margin around the drawing, in canvas units. */
	padding?: number;
}

// =============================================================================
// CONSTANTS AND HELPERS
// =============================================================================

/** The system font stack: an SVG opened elsewhere has none of the page's fonts. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** A caption is cut here, about the 150 px the canvas shows. */
const CAPTION_CHARS = 24;

/** Caption text size, and roughly how wide one character of it is. */
const CAPTION_SIZE = 11.5;
const CAPTION_CHAR = 6.4;

/** Drawn where a colour cannot be resolved. */
const FALLBACK_COLOUR = '#808080';

/** Opacity of what a path or a search leaves dimmed, and of an out-of-date node. */
const DIM_OPACITY = 0.2;
const STALE_OPACITY = 0.55;

/** The largest side and area a browser canvas reliably holds. */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 1.6e8;

/**
 * A number for an attribute: two decimals, no trailing zeros.
 *
 * @param n - A finite number.
 * @returns Compact text.
 */
function fmt(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Text for XML content or an attribute value.
 *
 * @param text - Any text.
 * @returns The text with `& < > " '` escaped.
 */
function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/**
 * A caption as the export writes it: one line, cut with an ellipsis.
 *
 * @param caption - The caption the canvas shows.
 * @returns At most {@link CAPTION_CHARS} characters and the ellipsis.
 */
function cut(caption: string): string {
	const chars = [...caption];
	return chars.length > CAPTION_CHARS ? `${chars.slice(0, CAPTION_CHARS).join('')}…` : caption;
}

// =============================================================================
// SVG
// =============================================================================

/**
 * Write the drawing as a standalone SVG.
 *
 * @param nodes - The drawn nodes, with their centres.
 * @param edges - The drawn relationships (one with an end that is not among the nodes is left out, as on the canvas).
 * @param theme - Background, text, halo, outline and accent colours.
 * @param options - The colour resolver, whether labels are written, and the margin.
 * @returns The SVG text and its size in pixels, or null when nothing is drawn.
 */
export function buildSvg(nodes: readonly IExportNode[], edges: readonly IExportEdge[], theme: IExportTheme, options: IExportOptions): { svg: string; width: number; height: number } | null {
	if (nodes.length === 0) return null;
	const paint = (css: string): string => {
		const value = options.resolve(css).trim();
		return value === '' || value.includes('var(') ? FALLBACK_COLOUR : value;
	};
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const centers = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
	const radiusOf = (id: string): number => byId.get(id)?.radius ?? 0;
	const drawn = edges.filter((e) => byId.has(e.source) && byId.has(e.target));
	const bounds = contentBounds(centers, drawn, radiusOf);
	if (!bounds) return null;
	// Captions are wider than their circles: the picture must not cut them.
	let minX = bounds.x;
	let maxX = bounds.x + bounds.width;
	for (const n of nodes) {
		const half = (Math.min(150, cut(n.caption).length * CAPTION_CHAR) / 2) | 0;
		minX = Math.min(minX, n.x - half);
		maxX = Math.max(maxX, n.x + half);
	}
	const padding = options.padding ?? 24;
	const x = Math.floor(minX - padding);
	const y = Math.floor(bounds.y - padding);
	const width = Math.ceil(maxX + padding) - x;
	const height = Math.ceil(bounds.y + bounds.height + padding) - y;

	const text = paint(theme.text);
	const halo = paint(theme.halo);
	const parts: string[] = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" font-family="${escapeXml(FONT)}">`);
	parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${paint(theme.background)}"/>`);

	for (const e of drawn) {
		const a = byId.get(e.source) as IExportNode;
		const b = byId.get(e.target) as IExportNode;
		const shape = edgeShape(a, b, e.slot, a.radius, b.radius);
		const stroke = paint(e.stroke);
		parts.push(`<g${e.dim ? ` opacity="${DIM_OPACITY}"` : ''}>`);
		parts.push(`<path d="${shape.path}" fill="none" stroke="${stroke}" stroke-width="${fmt(e.width)}"${e.dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
		parts.push(`<polygon points="${shape.arrow}" fill="${stroke}"/>`);
		if (options.labels) {
			const lx = fmt(shape.label.x);
			const ly = fmt(shape.label.y);
			parts.push(`<text x="${lx}" y="${ly}" transform="rotate(${fmt(shape.labelAngle)} ${lx} ${ly})" text-anchor="middle" dominant-baseline="central" font-size="10" fill="${text}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escapeXml(e.type)}</text>`);
		}
		parts.push('</g>');
	}

	for (const n of nodes) {
		const cx = fmt(n.x);
		const cy = fmt(n.y);
		parts.push(`<g${n.dim ? ` opacity="${DIM_OPACITY}"` : n.stale ? ` opacity="${STALE_OPACITY}"` : ''}>`);
		if (n.selected) parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(n.radius + 4.5)}" fill="none" stroke="${paint(theme.accent)}" stroke-width="3"/>`);
		parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(n.radius)}" fill="${paint(n.fill)}" stroke="${paint(theme.border)}" stroke-width="${n.stale ? 2 : 1}"${n.stale ? ' stroke-dasharray="4 3"' : ''}/>`);
		if (n.badgeMode === 'dot') parts.push(`<circle cx="${cx}" cy="${cy}" r="${fmt(Math.max(3, n.radius / 7))}" fill="${paint(n.textColor)}"/>`);
		else if (n.badgeMode === 'initials' && n.badge !== '') {
			parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fmt(Math.round(n.radius * 0.57))}" font-weight="700" fill="${paint(n.textColor)}">${escapeXml(n.badge)}</text>`);
		}
		parts.push(`<text x="${cx}" y="${fmt(n.y + n.radius + 5)}" text-anchor="middle" dominant-baseline="hanging" font-size="${CAPTION_SIZE}" fill="${text}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escapeXml(cut(n.caption))}</text>`);
		parts.push('</g>');
	}
	parts.push('</svg>');
	return { svg: parts.join(''), width, height };
}

// =============================================================================
// BROWSER SIDE: colours from the page, PNG from the SVG
// =============================================================================

/**
 * A resolver for `var(--x)` (and `var(--x, fallback)`) against an element's computed style, so the export is in the
 * colours the element shows now (the current theme). Any other colour passes through.
 *
 * @param element - The element whose variables apply (the canvas container).
 * @returns The resolver.
 */
export function cssResolver(element: Element): (css: string) => string {
	const style = getComputedStyle(element);
	return (css) => {
		const variable = /^var\((--[A-Za-z0-9_-]+)\s*(?:,\s*(.+))?\)$/.exec(css.trim());
		if (!variable) return css;
		const value = style.getPropertyValue(variable[1]).trim();
		return value !== '' ? value : (variable[2] ?? css);
	};
}

/**
 * The PNG scale for a drawing: twice its size, or less when that would pass what a browser canvas holds.
 *
 * @param width - The SVG's width in pixels.
 * @param height - The SVG's height in pixels.
 * @returns The scale, or 0 when the image would be too small to be of use (a quarter size or less).
 */
export function pngScale(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return 0;
	const scale = Math.min(2, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(MAX_CANVAS_AREA / (width * height)));
	return scale < 0.25 ? 0 : scale;
}

/**
 * Draw an SVG into a canvas and read it back as a PNG.
 *
 * @param svg - The SVG text (with its own width and height).
 * @param width - Its width in pixels.
 * @param height - Its height in pixels.
 * @returns The PNG, or null when it cannot be made (too large, no canvas, the image did not load).
 */
export function svgToPng(svg: string, width: number, height: number): Promise<Blob | null> {
	const scale = pngScale(width, height);
	if (scale === 0 || typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
		const finish = (blob: Blob | null): void => {
			URL.revokeObjectURL(url);
			resolve(blob);
		};
		const image = new Image();
		image.onload = () => {
			try {
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(width * scale));
				canvas.height = Math.max(1, Math.round(height * scale));
				const context = canvas.getContext('2d');
				if (!context) {
					finish(null);
					return;
				}
				context.scale(scale, scale);
				context.drawImage(image, 0, 0, width, height);
				canvas.toBlob((blob) => finish(blob), 'image/png');
			} catch {
				finish(null);
			}
		};
		image.onerror = () => finish(null);
		image.src = url;
	});
}

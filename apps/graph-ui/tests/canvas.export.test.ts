// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// IMAGE EXPORT: the SVG is built from the canvas's own layout data
// =============================================================================
//
// The export does not rasterise the page (no DOM-to-image library): it writes an SVG from
// the positions, colours, captions, badges and relationship geometry the canvas already
// holds. Colours on the canvas are CSS variables, which mean nothing outside the page, so
// every colour is resolved first. PNG is that SVG drawn into a canvas, in the browser only.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSvg, pngScale } from '../src/canvas/exportImage';
import type { IExportEdge, IExportNode, IExportTheme } from '../src/canvas/exportImage';
import { edgeSlots } from '../src/graph/geometry';

const THEME: IExportTheme = { background: 'var(--rr-bg-default)', text: 'var(--rr-text-primary)', halo: 'var(--rr-bg-paper)', border: 'var(--rr-text-primary)', accent: 'var(--rr-border-focus)' };
const COLOURS: Record<string, string> = { '--rr-bg-default': '#101418', '--rr-text-primary': '#f0f0f0', '--rr-bg-paper': '#1a1f24', '--rr-border-focus': '#4da3ff', '--rr-chart-1': '#3366cc', '--rr-text-secondary': '#a0a0a0' };
const resolve = (css: string): string => {
	const variable = /^var\((--[a-z0-9-]+)/i.exec(css);
	return variable ? COLOURS[variable[1]] ?? css : css;
};
const nodeAt = (id: string, x: number, caption: string, extra: Partial<IExportNode> = {}): IExportNode => ({ id, x, y: 0, radius: 28, fill: 'var(--rr-chart-1)', textColor: '#ffffff', badge: 'P', badgeMode: 'initials', caption, dim: false, stale: false, selected: false, ...extra });
const edge = (extra: Partial<IExportEdge> = {}): IExportEdge => ({ id: 'r', source: 'a', target: 'b', slot: edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).get('r')!, type: 'KNOWS', stroke: 'var(--rr-text-secondary)', width: 1.4, dashed: false, dim: false, ...extra });
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

test('two nodes and one relationship: two circles, one line with its arrow, the captions and badges, and every colour resolved', () => {
	const out = buildSvg([nodeAt('a', 0, 'Ada'), nodeAt('b', 300, 'Maya')], [edge()], THEME, { resolve, labels: true });
	assert.ok(out);
	const svg = out.svg;
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
	assert.equal(count(svg, /<circle /g), 2);
	assert.equal(count(svg, /<path /g), 1);
	assert.equal(count(svg, /<polygon /g), 1, 'the arrow head');
	assert.doesNotMatch(svg, /var\(/, 'no CSS variable is left: they mean nothing outside the page');
	assert.match(svg, /fill="#3366cc"/);
	assert.match(svg, /stroke="#a0a0a0"/);
	assert.match(svg, /<rect [^>]*fill="#101418"/, 'the canvas background is painted');
	assert.match(svg, />Ada<\/text>/);
	assert.match(svg, />Maya<\/text>/);
	assert.match(svg, />P<\/text>/);
	assert.match(svg, />KNOWS<\/text>/);
	assert.ok(out.width > 300 + 56 && out.height > 56, 'the whole drawing plus a margin');
	assert.match(svg, new RegExp(`width="${out.width}" height="${out.height}"`));
});

test('text is escaped, long captions are cut, and a colour that cannot be resolved falls back to a plain one', () => {
	const out = buildSvg([nodeAt('a', 0, '<b>&"Tom\'s"</b>'), nodeAt('b', 300, 'x'.repeat(80), { fill: 'var(--unknown)' })], [edge({ type: 'A&B' })], THEME, { resolve, labels: true });
	assert.ok(out);
	assert.match(out.svg, />&lt;b&gt;&amp;&quot;Tom&#39;s&quot;&lt;\/b&gt;<\/text>/);
	assert.match(out.svg, />A&amp;B<\/text>/);
	assert.doesNotMatch(out.svg, /x{80}/);
	assert.match(out.svg, /x+…<\/text>/);
	assert.doesNotMatch(out.svg, /var\(/);
});

test('what the canvas shows is what is exported: badges by mode, the selection ring, dashed out-of-date lines, dimmed elements, labels only when asked', () => {
	const out = buildSvg(
		[nodeAt('a', 0, 'A', { badgeMode: 'dot', selected: true }), nodeAt('b', 300, 'B', { badgeMode: 'none', dim: true, stale: true })],
		[edge({ dashed: true, dim: true, stroke: 'var(--rr-border-focus)', width: 3 })],
		THEME,
		{ resolve, labels: false }
	);
	assert.ok(out);
	assert.equal(count(out.svg, /<circle /g), 4, 'two nodes, a dot badge and a selection ring');
	assert.doesNotMatch(out.svg, />P<\/text>/, 'no initials in dot or none mode');
	assert.match(out.svg, /stroke-dasharray="5 4"/);
	assert.match(out.svg, /opacity="0\.2"/);
	assert.match(out.svg, /stroke="#4da3ff" stroke-width="3"/);
	assert.doesNotMatch(out.svg, />KNOWS</, 'labels left out when the drawing hides them');
});

test('nothing drawn, nothing to export; the PNG scale stays inside what a browser canvas can hold', () => {
	assert.equal(buildSvg([], [], THEME, { resolve, labels: true }), null);
	assert.equal(pngScale(800, 600), 2);
	assert.ok(pngScale(12000, 400) * 12000 <= 16384);
	assert.ok(pngScale(9000, 9000) ** 2 * 9000 * 9000 <= 16_777_216 + 1, 'within Safari\'s canvas area');
	assert.ok(pngScale(3000, 2000) ** 2 * 3000 * 2000 <= 16_777_216 + 1);
	assert.equal(pngScale(2e6, 10), 0, 'too big to draw at any useful size');
});

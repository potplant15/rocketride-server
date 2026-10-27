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
// GRAPH - LEGEND (every label on the canvas, with its colour and count)
// =============================================================================
//
// The legend is what makes colour optional: each label on the canvas is named next
// to its swatch, and counts say how many drawn nodes carry it. A node is counted
// under its FIRST label (the one that sets its colour); a node with no label is
// listed as "(no label)". Counts are of the nodes DRAWN, never of the database.
// =============================================================================

import { colorFor } from './colors';
import type { ILabelColor } from './colors';
import type { IGraphModel } from './model';

/** One legend line. */
export interface ILegendEntry {
	/** The label ('' for nodes with none). */
	label: string;
	/** What to print. */
	name: string;
	fill: string;
	count: number;
}

/**
 * The legend of a model.
 *
 * @param model - The canvas model.
 * @param colors - The connection's label colours.
 * @returns Entries, most nodes first, then by name.
 */
export function legendOf(model: Pick<IGraphModel, 'nodes'>, colors: ReadonlyMap<string, ILabelColor>): ILegendEntry[] {
	const counts = new Map<string, number>();
	for (const node of model.nodes.values()) {
		const label = node.labels[0] ?? '';
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, name: label === '' ? '(no label)' : label, fill: colorFor(colors, label).fill, count }))
		.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One relationship-type line of the legend. */
export interface ITypeLegendEntry {
	type: string;
	count: number;
	/** The colour the person gave the type, or null for the ordinary line colour. */
	fill: string | null;
}

/**
 * The relationship types of a model, with how many of each are drawn.
 *
 * @param model - The canvas model.
 * @param typeColors - The colours the connection's style gives types (colors.ts `typeColorsOf`).
 * @returns Entries, most relationships first, then by name.
 */
export function typeLegendOf(model: Pick<IGraphModel, 'relationships'>, typeColors: ReadonlyMap<string, string>): ITypeLegendEntry[] {
	const counts = new Map<string, number>();
	for (const rel of model.relationships.values()) counts.set(rel.type, (counts.get(rel.type) ?? 0) + 1);
	return [...counts.entries()]
		.map(([type, count]) => ({ type, count, fill: typeColors.get(type) ?? null }))
		.sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/**
 * The drawn nodes whose first label is a given one (what "click a label in the legend" selects).
 *
 * @param model - The canvas model.
 * @param label - A label ('' for nodes with none).
 * @returns Their ids, in drawing order.
 */
export function nodeIdsOfLabel(model: Pick<IGraphModel, 'nodes'>, label: string): string[] {
	const ids: string[] = [];
	for (const node of model.nodes.values()) if ((node.labels[0] ?? '') === label) ids.push(node.id);
	return ids;
}

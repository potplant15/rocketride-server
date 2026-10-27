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

// =============================================================================
// GRAPH-UI - LEGEND (labels and relationship types, with their style editor)
// =============================================================================
//
// Replaces the legend strip. It lists the labels and the relationship types
// that are DRAWN, each with its swatch and how many are drawn (never a database
// count). Clicking a label selects the drawn nodes that carry it. "Style" opens
// the inline editor (StyleEditor) for that label or type; edits go to the
// connection's style through the owner, which writes them to `env.userData`.
// The panel collapses to its title to give the canvas the room.
//
// Colour is never the only carrier of meaning: every row names its label or type.
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import { captionChoices } from '../graph/captions';
import { CHART_COLOR_VARS, TYPE_COLOR_SLOTS } from '../graph/colors';
import type { ILabelColor } from '../graph/colors';
import type { ILegendEntry, ITypeLegendEntry } from '../graph/legend';
import type { GraphNode } from '../graph/types';
import type { ILabelStyle, IConnectionStyle, StyleEdit } from '../graph/userData';
import { StyleEditor } from './StyleEditor';

/** Props. */
export interface ILegendPanelProps {
	labels: readonly ILegendEntry[];
	types: readonly ITypeLegendEntry[];
	/** The colours of every label of the connection (for "the same colour as"). */
	colors: ReadonlyMap<string, ILabelColor>;
	style: IConnectionStyle;
	captions: ReadonlyMap<string, string>;
	/** The drawn nodes, for the caption choices. */
	nodes: readonly GraphNode[];
	/** Select the drawn nodes of a label. */
	onSelectLabel(label: string): void;
	onCaption(label: string, choice: string): void;
	/** Apply a style edit; rejects with the reason it could not be kept. */
	onEdit(edit: StyleEdit): Promise<void>;
	/** One true sentence: where styles are kept on this mount. */
	privacyNote: string;
}

const styles = {
	root: { borderTop: '1px solid var(--rr-border)', fontSize: 12 } as CSSProperties,
	head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 10px' } as CSSProperties,
	title: { margin: 0, fontSize: 12, fontWeight: 600 } as CSSProperties,
	body: { padding: '2px 10px 6px', maxHeight: 110, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
	group: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } as CSSProperties,
	groupName: { color: 'var(--rr-text-secondary)', marginRight: 6 } as CSSProperties,
	swatch: (fill: string): CSSProperties => ({ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: fill, border: '1px solid var(--rr-text-primary)', marginRight: 6, verticalAlign: 'middle' }),
	line: (fill: string): CSSProperties => ({ display: 'inline-block', width: 16, height: 0, borderTop: `3px solid ${fill}`, marginRight: 6, verticalAlign: 'middle' }),
	note: { color: 'var(--rr-text-secondary)' } as CSSProperties,
};

/** What is being styled. */
type Editing = { kind: 'label'; name: string } | { kind: 'type'; name: string };

/**
 * The legend.
 *
 * @param props - See {@link ILegendPanelProps}.
 * @returns The panel.
 */
export const LegendPanel: React.FC<ILegendPanelProps> = ({ labels, types, colors, style, captions, nodes, onSelectLabel, onCaption, onEdit, privacyNote }) => {
	const [collapsed, setCollapsed] = useState(false);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);

	const usedBy = useMemo(() => {
		const out = new Map<number, string>();
		for (const [label, color] of colors) if (color.slot !== null && !out.has(color.slot)) out.set(color.slot, label);
		return out;
	}, [colors]);

	const apply = (edit: StyleEdit): void => {
		setError(null);
		onEdit(edit).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
	};
	const labelStyleOf = (label: string): ILabelStyle => (Object.prototype.hasOwnProperty.call(style.labels, label) ? style.labels[label] : {});
	const clean = (next: ILabelStyle): ILabelStyle | null => {
		const out: ILabelStyle = {};
		if (next.slot !== undefined) out.slot = next.slot;
		if (next.size !== undefined && next.size !== 'M') out.size = next.size;
		if (next.badge !== undefined && next.badge !== 'initials') out.badge = next.badge;
		return Object.keys(out).length === 0 ? null : out;
	};

	const editor = (() => {
		if (!editing) return null;
		if (editing.kind === 'label') {
			const label = editing.name;
			const own = labelStyleOf(label);
			return (
				<StyleEditor
					kind="label"
					name={label === '' ? '(no label)' : label}
					style={own}
					slots={CHART_COLOR_VARS.map((_, i) => i)}
					currentSlot={colors.get(label)?.slot ?? null}
					usedBy={usedBy}
					captionChoices={captionChoices(nodes.filter((n) => (n.labels[0] ?? '') === label))}
					caption={captions.get(label) ?? ''}
					onCaption={(choice) => onCaption(label, choice)}
					onChange={(next) => apply({ kind: 'label', label, style: clean(next) })}
					onReset={() => {
						apply({ kind: 'label', label, style: null });
						onCaption(label, '');
					}}
					onDone={() => setEditing(null)}
					error={error}
				/>
			);
		}
		const type = editing.name;
		const own: ILabelStyle = Object.prototype.hasOwnProperty.call(style.types, type) ? { slot: style.types[type]?.slot } : {};
		return (
			<StyleEditor
				kind="type"
				name={`:${type}`}
				style={own}
				slots={TYPE_COLOR_SLOTS}
				currentSlot={null}
				usedBy={new Map()}
				onChange={(next) => apply({ kind: 'type', type, style: next.slot === undefined ? null : { slot: next.slot } })}
				onReset={() => apply({ kind: 'type', type, style: null })}
				onDone={() => setEditing(null)}
				error={error}
			/>
		);
	})();

	return (
		<section aria-label="Legend" style={styles.root}>
			<div style={styles.head}>
				<h3 style={styles.title}>Legend</h3>
				<Button variant="ghost" small ariaExpanded={!collapsed} title={collapsed ? 'Show the legend' : 'Collapse the legend'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show' : 'Collapse'}</Button>
			</div>
			{!collapsed && (
				<div style={styles.body}>
					<div style={styles.group} role="group" aria-label="Labels">
						<span style={styles.groupName}>Labels</span>
						{labels.map((entry) => (
							<span key={entry.label || '(none)'} style={{ display: 'inline-flex', alignItems: 'center' }}>
								<Button variant="ghost" small title={`Select the ${entry.count} drawn ${entry.count === 1 ? 'node' : 'nodes'} with this label`} onClick={() => onSelectLabel(entry.label)}>
									<span style={styles.swatch(entry.fill)} aria-hidden="true" />
									{`${entry.name} (${entry.count})`}
								</Button>
								{entry.label !== '' && <Button variant="ghost" small ariaExpanded={editing?.kind === 'label' && editing.name === entry.label} title={`Style ${entry.name}`} onClick={() => setEditing({ kind: 'label', name: entry.label })}>{`Style: ${entry.name}`}</Button>}
							</span>
						))}
					</div>
					{types.length > 0 && (
						<div style={styles.group} role="group" aria-label="Relationship types">
							<span style={styles.groupName}>Relationship types</span>
							{types.map((entry) => (
								<span key={entry.type} style={{ display: 'inline-flex', alignItems: 'center' }}>
									<span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 6px' }}>
										<span style={styles.line(entry.fill ?? 'var(--rr-text-secondary)')} aria-hidden="true" />
										{`${entry.type} (${entry.count})`}
									</span>
									<Button variant="ghost" small ariaExpanded={editing?.kind === 'type' && editing.name === entry.type} title={`Style ${entry.type}`} onClick={() => setEditing({ kind: 'type', name: entry.type })}>{`Style: ${entry.type}`}</Button>
								</span>
							))}
						</div>
					)}
					<div style={styles.note}>{`Colour, size, caption and badge per label; colour per relationship type. ${privacyNote}`}</div>
				</div>
			)}
			{!collapsed && editor}
		</section>
	);
};

export default LegendPanel;

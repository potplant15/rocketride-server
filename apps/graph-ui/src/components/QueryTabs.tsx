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
// GRAPH-UI - QUERY TABS (the workbench's tab strip)
// =============================================================================
//
// A WAI-ARIA tab list with automatic activation: ArrowLeft and ArrowRight move
// to the next tab and show it (wrapping), Home and End go to the first and the
// last, Delete closes a query tab. Only the shown tab is in the Tab order. Each
// query tab has a close button for the mouse (out of the Tab order; Delete is
// its key), and "New query" opens a tab at the end. The strip is the left part
// of the workbench's tab row; the shown tab's run bar takes the rest.
//
// Keys are the tab list's own onKeyDown: no document or window listener.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { BxX, Button } from 'shell';
import { stepTab } from '../graph/queryTabs';

/** One tab as the strip shows it. */
export interface IStripTab {
	id: string;
	title: string;
	closable: boolean;
}

/** Props. */
export interface IQueryTabsProps {
	tabs: readonly IStripTab[];
	active: string;
	/** Makes the tab and panel ids unique in the realm (several documents share one page). */
	idPrefix: string;
	onActivate(id: string): void;
	onClose(id: string): void;
	/** Open an empty query tab (past the limit, the workbench says why it did not). */
	onNew(): void;
}

/**
 * The id of a tab's button.
 *
 * @param prefix - The strip's id prefix.
 * @param id - The tab.
 * @returns The element id.
 */
export function tabElementId(prefix: string, id: string): string {
	return `${prefix}-tab-${id}`;
}

/**
 * The id of a tab's panel.
 *
 * @param prefix - The strip's id prefix.
 * @param id - The tab.
 * @returns The element id.
 */
export function panelElementId(prefix: string, id: string): string {
	return `${prefix}-panel-${id}`;
}

const styles = {
	strip: { flex: '1 1 220px', minWidth: 160, display: 'flex', alignItems: 'flex-end', gap: 8, alignSelf: 'stretch' } as CSSProperties,
	list: { display: 'flex', alignItems: 'flex-end', gap: 2, minWidth: 0, overflowX: 'auto' } as CSSProperties,
	tab: (selected: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 2,
		flexShrink: 0,
		maxWidth: 240,
		borderBottom: selected ? '2px solid var(--rr-border-focus)' : '2px solid transparent',
	}),
	label: (selected: boolean): CSSProperties => ({
		maxWidth: 220,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		padding: '6px 8px',
		border: 'none',
		background: 'transparent',
		cursor: 'pointer',
		font: 'inherit',
		fontSize: 13,
		fontWeight: selected ? 600 : 400,
		color: selected ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
	}),
	close: { display: 'inline-flex', alignItems: 'center', padding: 2, marginRight: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--rr-text-secondary)', borderRadius: 3 } as CSSProperties,
	add: { flexShrink: 0, alignSelf: 'center' } as CSSProperties,
};

/**
 * The strip.
 *
 * @param props - See {@link IQueryTabsProps}.
 * @returns The tab list and its New query button.
 */
export const QueryTabs: React.FC<IQueryTabsProps> = ({ tabs, active, idPrefix, onActivate, onClose, onNew }) => {
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	// Set when a key moved the selection, so the shown tab takes the focus once it is rendered.
	const follow = useRef(false);
	useEffect(() => {
		if (!follow.current) return;
		follow.current = false;
		buttons.current.get(active)?.focus();
	}, [active, tabs]);

	const order = tabs.map((tab) => tab.id);
	return (
		<div style={styles.strip}>
			<div
				role="tablist"
				aria-label="Query tabs"
				style={styles.list}
				onKeyDown={(event) => {
					const current = (event.target as HTMLElement).getAttribute('data-tab');
					if (current === null) return;
					if (event.key === 'Delete') {
						const tab = tabs.find((t) => t.id === current);
						if (!tab?.closable) return;
						event.preventDefault();
						follow.current = true;
						onClose(current);
						return;
					}
					const next = stepTab(order, current, event.key);
					if (next === null) return;
					event.preventDefault();
					follow.current = true;
					onActivate(next);
				}}
			>
				{tabs.map((tab) => {
					const selected = tab.id === active;
					return (
						<div key={tab.id} role="presentation" style={styles.tab(selected)}>
							<button
								ref={(el) => {
									if (el) buttons.current.set(tab.id, el);
									else buttons.current.delete(tab.id);
								}}
								type="button"
								role="tab"
								data-tab={tab.id}
								id={tabElementId(idPrefix, tab.id)}
								aria-selected={selected}
								aria-controls={panelElementId(idPrefix, tab.id)}
								tabIndex={selected ? 0 : -1}
								title={tab.closable ? `${tab.title} (Delete closes it)` : tab.title}
								style={styles.label(selected)}
								onClick={() => onActivate(tab.id)}
							>
								{tab.title}
							</button>
							{tab.closable && (
								<button type="button" tabIndex={-1} aria-hidden="true" title={`Close ${tab.title}`} style={styles.close} onClick={() => onClose(tab.id)}>
									<BxX size={14} />
								</button>
							)}
						</div>
					);
				})}
			</div>
			<span style={styles.add}>
				<Button variant="ghost" small title="Open an empty query tab" onClick={onNew}>
					+ New query
				</Button>
			</span>
		</div>
	);
};

export default QueryTabs;

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
// SQL-UI — RECORD DRAWER (one row of the data browser, in full)
// =============================================================================
//
// A row click in the data browser opens this drawer on the shell's
// DetailPanel. Fields follow the table's reflected column order (the row
// object's own keys are not a column list; see `sql/record.ts`), with Prev and
// Next across the page, and a copy button per value and for the whole row.
//
// A foreign-key value is a link. It looks the referenced row up (bound values,
// LIMIT 2) and opens it in a drawer stacked on this one; the shell's back
// arrow, or Back, returns. "Rows that reference this one" lists the child
// tables, and Show rows opens a child's Data page with filter chips preset.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { inspectorText } from 'shared/explorer/components/RowInspector';
import { Banner, Button, DetailPanel, LabelValue, Section, StatusBadge } from 'shell';
import { announce } from '../a11y/announce';
import type { SqlDialect, SqlSchemaTable } from '../connect';
import type { RelationEdge, RelationGraph } from '../schema/relations';
import type { FilterChip } from '../sql/filters';
import { childRowsPreset, fallbackDef, hasKeyValues, recordFields, recordJson, referencedRowStatement, referencingEdges } from '../sql/record';

/** What a row of SQL values loses on the way to the browser. */
const NOTE = 'Very large numbers and decimals may be shown rounded.';

/** Props for the {@link RecordDrawer} component. */
export interface RecordDrawerProps {
	/** The engine dialect (quotes the lookup). */
	dialect: SqlDialect;
	/** The connection's declared foreign keys. */
	graph: RelationGraph;
	/** The reflected tables, for the fields of a looked-up row. */
	tables: Record<string, SqlSchemaTable>;
	/** The table being browsed. */
	table: string;
	/** The current page's rows. */
	rows: readonly Record<string, unknown>[];
	/** Index of the open row within `rows`, or null when the drawer is closed. */
	index: number | null;
	/** Rows before this page, so the title reads "Row N" across pages. */
	offset: number;
	/** Fired with the row Prev or Next moved to. */
	onIndexChange: (index: number) => void;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
	/** Runs a bound SELECT; null when the connection cannot run statements. */
	lookup: ((sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) | null;
	/** Opens a table's Data page with these chips preset; absent = no Show rows. */
	onShowRows?: (table: string, chips: FilterChip[]) => void;
}

/** One row opened by following a foreign key. */
interface Followed {
	/** The table the row belongs to. */
	table: string;
	/** The row. */
	row: Record<string, unknown>;
	/** Its columns: the schema's, or the row's own when the schema lacks the table. */
	def: SqlSchemaTable;
	/** Where it was reached from, e.g. `orders.customer_id`. */
	from: string;
	/** Set when the lookup matched more than one row. */
	ambiguous: boolean;
}

const styles = {
	valueRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 8,
	} as CSSProperties,

	value: {
		flex: 1,
		minWidth: 0,
		margin: 0,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	link: {
		background: 'none',
		border: 'none',
		padding: 0,
		font: 'inherit',
		color: 'var(--rr-color-info)',
		textDecoration: 'underline',
		cursor: 'pointer',
		textAlign: 'left',
	} as CSSProperties,

	type: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	note: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		padding: '8px 0 0',
	} as CSSProperties,

	child: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		padding: '4px 0',
		fontSize: 12,
	} as CSSProperties,

	status: {
		marginBottom: 8,
	} as CSSProperties,
};

/**
 * Copy text to the clipboard and announce the outcome. A missing Clipboard
 * API or a refusal announces a failure rather than passing silently.
 *
 * @param text - The text to copy.
 * @param what - What was copied, for the announcement.
 */
function copy(text: string, what: string): void {
	if (!navigator.clipboard) {
		announce(`Could not copy ${what}`);
		return;
	}
	void navigator.clipboard.writeText(text).then(
		() => { announce(`Copied ${what}`); },
		() => { announce(`Could not copy ${what}`); },
	);
}

/** Props for one drawer level. */
interface LevelProps {
	/** Reflected schema of the row's table. */
	def: SqlSchemaTable;
	/** The row's table. */
	table: string;
	/** The row. */
	row: Record<string, unknown>;
	title: string;
	subtitle: string;
	/** Footer buttons before Copy/Close (Prev, Next on the first level). */
	nav?: React.ReactNode;
	closeLabel: string;
	onClose: () => void;
	ambiguous?: boolean;
	/** Following a key; null disables the links (a schema-only node). */
	onFollow: ((edge: RelationEdge, row: Record<string, unknown>, table: string) => void) | null;
	graph: RelationGraph;
	onShowRows?: (table: string, chips: FilterChip[]) => void;
	/** Lookup state shown above the fields. */
	status?: React.ReactNode;
}

/**
 * One drawer: the fields of one row, its links, and the tables that
 * reference it.
 *
 * @param props - {@link LevelProps}.
 * @returns The drawer element.
 */
const Level: React.FC<LevelProps> = ({ def, table, row, title, subtitle, nav, closeLabel, onClose, ambiguous, onFollow, graph, onShowRows, status }) => {
	const fields = recordFields(def, row, graph, table);
	const children = referencingEdges(graph, table);
	return (
		<DetailPanel
			open
			onClose={onClose}
			title={title}
			subtitle={subtitle}
			modeless
			width={460}
			footer={
				<>
					{nav}
					<Button variant="secondary" onClick={() => copy(recordJson(def, row), 'row as JSON')}>Copy row as JSON</Button>
					<Button variant="ghost" onClick={onClose}>{closeLabel}</Button>
				</>
			}
		>
			{status && <div style={styles.status}>{status}</div>}
			{ambiguous && (
				<div style={styles.status}>
					<Banner variant="warning">More than one row matches this key. Showing the first.</Banner>
				</div>
			)}
			<Section label={`Fields (${fields.length})`}>
				{fields.map((field) => {
					const text = inspectorText(field.value);
					// The first key the column belongs to; a NULL key has nothing to open.
					const link = field.links.find((edge) => hasKeyValues(edge, row));
					return (
						<LabelValue key={field.column} label={field.column} mono>
							<div style={styles.valueRow}>
								{link && onFollow ? (
									<button
										type="button"
										style={{ ...styles.link, ...styles.value }}
										title={`Open ${link.refTable} row`}
										onClick={() => onFollow(link, row, table)}
									>
										{text}
									</button>
								) : (
									<pre style={styles.value}>{text}</pre>
								)}
								{field.pk && <StatusBadge variant="info">PK</StatusBadge>}
								<Button variant="ghost" small title={`Copy ${field.column}`} onClick={() => copy(text, field.column)}>Copy</Button>
							</div>
							<div style={styles.type}>{field.type}{field.links.length > 0 ? ` → ${field.links.map((e) => e.refTable).join(', ')}` : ''}</div>
						</LabelValue>
					);
				})}
			</Section>
			{children.length > 0 && (
				<Section label="Rows that reference this one">
					{children.map((edge) => {
						const chips = childRowsPreset(edge, row);
						return (
							<div key={edge.id} style={styles.child}>
								<span>{edge.table}.{edge.columns.join(', ')}</span>
								{onShowRows && (
									<Button variant="secondary" small disabled={!chips} onClick={() => chips && onShowRows(edge.table, chips)}>
										Show rows
									</Button>
								)}
							</div>
						);
					})}
				</Section>
			)}
			<div style={styles.note}>{NOTE}</div>
		</DetailPanel>
	);
};

/**
 * The record drawer for the data browser.
 *
 * @param props - {@link RecordDrawerProps}.
 * @returns The drawer stack, or null when closed.
 */
export const RecordDrawer: React.FC<RecordDrawerProps> = ({ dialect, graph, tables, table, rows, index, offset, onIndexChange, onClose, lookup, onShowRows }) => {
	// Rows reached by following keys, outermost first.
	const [followed, setFollowed] = useState<Followed[]>([]);
	// The lookup in flight or its failure, shown on the level it was started from.
	const [status, setStatus] = useState<{ depth: number; kind: 'busy' | 'none' | 'error'; text: string } | null>(null);
	const seqRef = useRef(0);

	// Another row (or closing) drops the stack: it belonged to the previous row.
	useEffect(() => {
		seqRef.current++;
		setFollowed([]);
		setStatus(null);
	}, [index, table]);

	const follow = useCallback((depth: number) => (edge: RelationEdge, row: Record<string, unknown>, fromTable: string): void => {
		const stmt = referencedRowStatement(dialect, edge, row);
		if (!stmt || !lookup) return;
		const seq = ++seqRef.current;
		const where = edge.refColumns.map((c, i) => `${c} = ${String(row[edge.columns[i]!])}`).join(', ');
		setStatus({ depth, kind: 'busy', text: `Looking up ${edge.refTable}...` });
		lookup(stmt.sql, stmt.params).then(
			(found) => {
				if (seq !== seqRef.current) return;
				const first = found[0];
				if (!first) {
					setStatus({ depth, kind: 'none', text: `No row in ${edge.refTable} where ${where}.` });
					return;
				}
				setStatus(null);
				setFollowed((current) => [
					...current.slice(0, depth),
					{ table: edge.refTable, row: first, def: tables[edge.refTable] ?? fallbackDef(first), from: `${fromTable}.${edge.columns.join(', ')}`, ambiguous: found.length > 1 },
				]);
			},
			(err: unknown) => {
				if (seq !== seqRef.current) return;
				setStatus({ depth, kind: 'error', text: `Could not open the ${edge.refTable} row: ${err instanceof Error ? err.message : String(err)}` });
			},
		);
	}, [dialect, lookup, tables]);

	const row = index === null ? undefined : rows[index];
	const def = tables[table];
	if (index === null || !row || !def) return null;

	const statusFor = (depth: number): React.ReactNode => {
		if (!status || status.depth !== depth) return undefined;
		return <Banner variant={status.kind === 'error' ? 'error' : status.kind === 'none' ? 'warning' : 'info'}>{status.text}</Banner>;
	};

	return (
		<>
			<Level
				def={def}
				table={table}
				row={row}
				title={`Row ${(offset + index + 1).toLocaleString()}`}
				subtitle={table}
				nav={
					<>
						<Button variant="ghost" disabled={index <= 0} onClick={() => onIndexChange(index - 1)}>Prev</Button>
						<Button variant="ghost" disabled={index >= rows.length - 1} onClick={() => onIndexChange(index + 1)}>Next</Button>
					</>
				}
				closeLabel="Close"
				onClose={onClose}
				onFollow={lookup ? follow(0) : null}
				graph={graph}
				onShowRows={onShowRows}
				status={statusFor(0)}
			/>
			{followed.map((level, depth) => {
				return (
					<Level
						key={`${level.table}-${depth}`}
						def={level.def}
						table={level.table}
						row={level.row}
						title={level.table}
						subtitle={`from ${level.from}`}
						closeLabel="Back"
						onClose={() => setFollowed((current) => current.slice(0, depth))}
						ambiguous={level.ambiguous}
						onFollow={lookup ? follow(depth + 1) : null}
						graph={graph}
						onShowRows={onShowRows}
						status={statusFor(depth + 1)}
					/>
				);
			})}
		</>
	);
};

export default RecordDrawer;

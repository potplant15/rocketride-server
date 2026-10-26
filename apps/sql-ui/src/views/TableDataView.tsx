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
// SQL-UI — TABLE DATA VIEW (server-paged data browser for one table)
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGeneration } from 'shared/explorer/generation';
import type { CSSProperties } from 'react';
import type { GridCellComponent } from 'shell';
import { Banner, Button, Card, ContentHeader, DataGrid, EmptyState, monoEl, mutedEl } from 'shell';
import type { GridColumnDefinition, IDataGridHandle, IDataGridPage, IDataGridPageRequest } from 'shell';
import { commonStyles } from 'shell';
import type { SqlEndpoint } from '../connect';
import { useSchema } from '../schema/schemaStore';
import { useSqlEnv } from '../sqlEnv';
import { buildPageStatements, countKey } from '../sql/paging';
import {
	applyProbeResult,
	applyTotal,
	emptyCountCache,
	estimateStatement,
	invalidateTotals,
	overfetchPage,
	planCount,
} from '../sql/estimate';
import type { CountCache } from '../sql/estimate';
import type { FilterChip } from '../sql/filters';
import { buildRelationGraph, fkMarker } from '../schema/relations';
import { FilterChips } from '../components/FilterChips';
import type { SortChip } from '../components/FilterChips';
import { RecordDrawer } from '../components/RecordDrawer';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TableDataView} component. */
export interface TableDataViewProps {
	/** The connection the table lives on. */
	endpoint: SqlEndpoint;
	/** The table to browse. */
	table: string;
	/**
	 * Whether the connection can run statements. False = schema only: the
	 * browser sends no page, count or estimate statement (default true).
	 */
	executeAllowed?: boolean;
	/** Filter chips the page opens with (a foreign key's "Show rows"). */
	presetFilters?: readonly FilterChip[];
	/**
	 * Bump this after a write to the table (a staged apply, say): the cached
	 * totals are forgotten and the current page is requested again, so the
	 * pager does not keep an old count. The catalog estimate is kept.
	 */
	countEpoch?: number;
	/** Opens another table's Data page with chips preset; absent = no "Show rows". */
	onOpenTable?: (table: string, chips: FilterChip[]) => void;
}

/** What the count line says when the pager's total is not an exact count. */
type CountNote = { kind: 'estimate'; rows: number } | { kind: 'more'; estimate: number | null } | null;

/** The row drawer's state: a snapshot of the page the row was clicked on. */
interface OpenRow {
	/** The page's rows as fetched (the grid is handed copies). */
	rows: Record<string, unknown>[];
	/** Index of the open row. */
	index: number;
	/** Rows before the page. */
	offset: number;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Grid region below the header — the grid pages internally.
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		padding: '16px 24px 24px',
	} as CSSProperties,

	// One-line caveat above the grid (no primary key = no stable page order).
	note: {
		margin: '0 0 8px',
		fontSize: 12,
		opacity: 0.7,
	} as CSSProperties,

	// The count line: the estimate or "more rows" note with its button.
	countNote: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		margin: '0 0 8px',
		fontSize: 12,
		opacity: 0.85,
	} as CSSProperties,

	// The load-failure banner sits above the grid, inside the body padding.
	banner: {
		marginBottom: 8,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Render one data cell: NULL muted, objects as JSON, everything else mono.
 *
 * @param value - The raw cell value.
 * @returns The formatted cell element.
 */
function dataCellEl(value: unknown): HTMLElement {
	if (value === null || value === undefined) return mutedEl('NULL');
	if (typeof value === 'object') return monoEl(JSON.stringify(value));
	return monoEl(String(value));
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Server-paged browser for one table: a REMOTE-mode DataGrid whose fetchPage
 * turns each page request into SELECT + COUNT statements (LIMIT/OFFSET,
 * ORDER BY from the grid's sorters, WHERE from search + column filters) and
 * executes them through the connection's session.
 */
export const TableDataView: React.FC<TableDataViewProps> = ({ endpoint, table, executeAllowed = true, presetFilters, countEpoch, onOpenTable }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);

	// Last page-load failure, surfaced as a banner. The grid keeps showing the
	// previous rows on failure, so without this the error is invisible.
	const [loadError, setLoadError] = useState<string | null>(null);

	// The grid's current sorters. Read from the page requests themselves —
	// remote sorting is the only way sorters reach here.
	const [gridSort, setGridSort] = useState<SortChip[]>([]);

	const gridRef = useRef<IDataGridHandle>(null);

	// Filter chips. The ref is what a page request reads, so changing a chip
	// does not change `fetchPage`'s identity (which would rebuild the grid);
	// the effect below asks the grid for page 1 again.
	const [chips, setChipsState] = useState<FilterChip[]>(() => [...(presetFilters ?? [])]);
	const chipsRef = useRef<FilterChip[]>(chips);
	const setChips = useCallback((next: FilterChip[]): void => {
		chipsRef.current = next;
		setChipsState(next);
	}, []);
	const chipsMounted = useRef(false);
	useEffect(() => {
		// The first fetch already reads the preset chips.
		if (!chipsMounted.current) {
			chipsMounted.current = true;
			return;
		}
		gridRef.current?.refetch({ resetPage: true });
	}, [chips]);

	// What is known about this table's size and the total shown for the
	// current filter (see sql/estimate.ts). "Count exactly" sets the flag the
	// next request reads.
	const countRef = useRef<CountCache>(emptyCountCache(table));
	const forceExactRef = useRef(false);
	const [countNote, setCountNote] = useState<CountNote>(null);

	// A write changed the table: forget the totals and ask for the page again.
	const epochSeen = useRef(countEpoch);
	useEffect(() => {
		if (epochSeen.current === countEpoch) return;
		epochSeen.current = countEpoch;
		countRef.current = invalidateTotals(countRef.current);
		gridRef.current?.refetch();
	}, [countEpoch]);

	// The page the grid shows, for the row drawer: the rows as fetched, and
	// the copies the grid was handed (Tabulator writes into those).
	const pageRef = useRef<{ rows: Record<string, unknown>[]; gridRows: Record<string, unknown>[]; offset: number }>({ rows: [], gridRows: [], offset: 0 });
	const [openRow, setOpenRow] = useState<OpenRow | null>(null);

	// Stale-response guard. Two page requests can be in flight (a fast typist
	// on the search box, a double page click), and the grid applies whichever
	// resolves LAST — so a slow earlier answer can overwrite a newer one. Each
	// request takes a sequence number; a request that has been superseded by
	// the time it resolves adopts the newest answer instead of landing its own.
	const seqRef = useRef(0);
	const newestRef = useRef<Promise<IDataGridPage<Record<string, unknown>>> | null>(null);

	// The same rule, carried down to the session (port of 740b69c6d): each page
	// request takes a ticket, which the next request (or closing the view)
	// expires. The session then sends nothing more for a superseded request,
	// its one retry after a restart included, and its late answer is dropped.
	const [generation] = useState(createGeneration);
	useEffect(() => () => generation.invalidate(), [generation]);

	// The row drawer's foreign-key lookups have a ticket sequence of their own:
	// opening another key expires the lookup before it, and a page request's
	// ticket never expires a lookup (nor the other way round).
	const [lookupGeneration] = useState(createGeneration);
	useEffect(() => () => lookupGeneration.invalidate(), [lookupGeneration]);

	// The table's reflected schema drives columns, search targets, and the
	// default sort (primary key).
	const tableDef = snapshot.schema?.tables?.[table] ?? null;
	const dialect = snapshot.dialect;

	const graph = useMemo(() => buildRelationGraph(snapshot.schema), [snapshot.schema]);

	// Grid columns straight from the reflected schema.
	const columns = useMemo<GridColumnDefinition[]>(() => {
		if (!tableDef) return [];
		const pk = new Set(tableDef.primary_key ?? []);
		return tableDef.columns.map((col) => {
			const fk = fkMarker(graph, table, col.column);
			return {
				title: col.column,
				field: col.column,
				rrType: /int|dec|num|float|double/i.test(col.type) ? 'number' : 'string',
				rrDefault: true,
				rrDescription: `${col.type}${pk.has(col.column) ? ' - primary key' : ''}${fk ? ` ${fk}` : ''}`,
				headerSort: true,
				formatter: (cell: GridCellComponent) => dataCellEl(cell.getValue()),
			} satisfies GridColumnDefinition;
		});
	}, [tableDef, graph, table]);

	/**
	 * Run a bound SELECT for the row drawer's foreign-key links, on the
	 * lookups' own ticket sequence.
	 *
	 * @param sql - The statement.
	 * @param params - Its bind values.
	 * @returns The rows.
	 */
	const lookup = useCallback(async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
		const ticket = lookupGeneration.next();
		const result = await env.getSession(endpoint).execute(sql, { params, idempotent: true, generation: ticket });
		return result.rows;
	}, [env, endpoint, lookupGeneration]);

	/**
	 * REMOTE page fetcher: the page SELECT, plus whatever the count planner says
	 * the total needs (nothing for another page of a counted filter, the
	 * catalog estimate for a big unfiltered table, one extra row for a big
	 * filtered one, an exact COUNT otherwise). Every filter, chip and search
	 * value is bound as a `$n` parameter.
	 *
	 * @param req - The grid's page request.
	 * @returns The page rows and the matching total.
	 */
	const fetchPage = useCallback((req: IDataGridPageRequest): Promise<IDataGridPage<Record<string, unknown>>> => {
		setGridSort(req.sort.map((s) => ({ field: s.field, dir: s.dir })));
		const seq = ++seqRef.current;
		// The banner describes ONE request. A new search, sort or page is a
		// different question, so the previous answer's failure stops being
		// shown the moment this one starts rather than the moment it lands.
		setLoadError(null);
		const ticket = generation.next();

		const run = async (): Promise<{ page: IDataGridPage<Record<string, unknown>>; note: CountNote; source: Record<string, unknown>[] }> => {
			const empty = { page: { rows: [], total: 0 }, note: null, source: [] };
			if (!env.ready || !tableDef) return empty;
			const session = env.getSession(endpoint);
			const exec = (sql: string, params: unknown[]) => session.execute(sql, { params, idempotent: true, generation: ticket });
			if (countRef.current.table !== table) countRef.current = emptyCountCache(table);

			let stmts = buildPageStatements(dialect, table, tableDef, req, { chips: chipsRef.current });
			const key = countKey(table, stmts);
			// Read, not cleared: "Count exactly" survives a request that is
			// replaced or fails, and is cleared where the exact total lands.
			const forceExact = forceExactRef.current;
			const probe = estimateStatement(dialect, table);
			const countReq = { key, filtered: stmts.where !== '', executeAllowed, forceExact, canProbe: probe !== null };

			// A schema-only node runs nothing, so nothing is sent.
			let plan = planCount(countRef.current, countReq);
			if (plan === 'none') return empty;

			// The table's size is read once from the catalog; no estimate means
			// an exact count. A catalog the role cannot read is the same answer.
			if (plan === 'probe' && probe) {
				const settled = applyProbeResult(
					countRef.current,
					await exec(probe.sql, probe.params).then(
						(r) => ({ rows: r.rows }),
						// A probe replaced by a newer request says nothing about the
						// table: do not cache "no estimate" for it, just stop.
						() => ({ error: true as const, superseded: !ticket.isCurrent() }),
					),
				);
				if (!settled) throw new Error('superseded');
				countRef.current = settled;
				plan = planCount(countRef.current, countReq);
			}

			// A big filtered table is not counted: ask for one row past the page.
			if (plan === 'overfetch') {
				stmts = buildPageStatements(dialect, table, tableDef, req, { chips: chipsRef.current, overfetch: true });
				const result = await exec(stmts.select, stmts.params);
				const over = overfetchPage(result.rows, req.page, req.size);
				return {
					page: { rows: over.rows.map((r) => ({ ...r })), total: over.total },
					note: over.hasMore ? { kind: 'more', estimate: countRef.current.estimate ?? null } : null,
					source: over.rows,
				};
			}

			// Page rows (+ the exact total over the same WHERE, when planned). The
			// statements are independent, so one round trip. Both are SELECTs, so
			// they opt in to the session's one retry, which follows only a
			// TASK_STOPPED refusal raised before the statement reaches the node
			// (the task may be restarting since this view last paged).
			const [pageResult, countResult] = await Promise.all([
				exec(stmts.select, stmts.params),
				plan === 'count' ? exec(stmts.count, stmts.params) : Promise.resolve(null),
			]);

			let total: number;
			let note: CountNote = null;
			if (plan === 'count') {
				total = Number((countResult?.rows[0] as { total?: unknown } | undefined)?.total ?? pageResult.rows.length);
				forceExactRef.current = false;
				countRef.current = applyTotal(countRef.current, key, total, true);
			} else if (plan === 'estimate') {
				total = countRef.current.estimate ?? pageResult.rows.length;
				countRef.current = applyTotal(countRef.current, key, total, false);
				note = { kind: 'estimate', rows: total };
			} else {
				// Another page of a filter already counted.
				total = countRef.current.total ?? pageResult.rows.length;
				if (!countRef.current.exact) note = { kind: 'estimate', rows: total };
			}
			// The grid is handed copies: Tabulator writes a key into each row
			// object for every column it renders, so a row it has seen is not
			// a record of the result's columns.
			return { page: { rows: pageResult.rows.map((r) => ({ ...r })), total }, note, source: pageResult.rows };
		};

		const attempt = run();
		// `newest` is assigned BEFORE any await settles, so a superseded
		// request always finds the newer chain here — which in turn resolves
		// to the newest of all (each link applies the same rule).
		const chain = attempt.then(
			({ page, note, source }) => {
				if (seq !== seqRef.current) return newestRef.current ?? page;
				setLoadError(null);
				setCountNote(note);
				pageRef.current = { rows: source, gridRows: page.rows, offset: (req.page - 1) * req.size };
				return page;
			},
			(err: unknown) => {
				// A superseded request's failure is not the user's problem; the
				// request that replaced it reports its own outcome.
				if (seq !== seqRef.current && newestRef.current) return newestRef.current;
				throw err;
			},
		);
		newestRef.current = chain;
		return chain;
	}, [env, endpoint, table, tableDef, dialect, generation, executeAllowed]);

	/**
	 * Count the rows exactly (the user asked, after an estimate or a "more
	 * rows" page) and show the current page again with the exact total.
	 */
	const countExactly = useCallback((): void => {
		forceExactRef.current = true;
		gridRef.current?.refetch();
	}, []);

	/**
	 * Open the row drawer on a clicked row. The grid reports its own row
	 * object; the drawer reads the pristine copy of the same position.
	 *
	 * @param row - The row the grid reports.
	 */
	const handleRowClick = useCallback((row: Record<string, unknown>): void => {
		const { rows, gridRows, offset } = pageRef.current;
		const index = gridRows.indexOf(row);
		if (index >= 0 && rows[index]) setOpenRow({ rows, index, offset });
		else setOpenRow({ rows: [row], index: 0, offset });
	}, []);

	/**
	 * Mirror a removed sort chip onto the grid's sorters; the grid re-requests.
	 *
	 * @param next - The sorters that remain.
	 */
	const handleSortChange = useCallback((next: SortChip[]): void => {
		const grid = gridRef.current?.table;
		if (!grid) return;
		if (next.length === 0) grid.clearSort();
		else grid.setSort(next.map((s) => ({ column: s.field, dir: s.dir })));
	}, []);

	/**
	 * Surface a page-load failure (the grid itself only shows a transient
	 * toast and keeps the previous rows on screen).
	 *
	 * @param error - The error the page fetcher rejected with.
	 */
	const handleLoadError = useCallback((error: Error): void => {
		setLoadError(error.message || String(error));
	}, []);

	// ── Framing states ───────────────────────────────────────────────────────

	if (snapshot.status !== 'ready') {
		return (
			<div style={styles.root}>
				<ContentHeader title={table} subtitle="data" />
				<div style={styles.body}>
					<EmptyState icon={<DatabaseIcon />} title="Reading schema" description="The table's schema is still loading..." />
				</div>
			</div>
		);
	}

	if (!tableDef) {
		return (
			<div style={styles.root}>
				<ContentHeader title={table} subtitle="data" />
				<div style={styles.body}>
					<Banner variant="warning">
						Table {table} is not in the current schema snapshot. Refresh the schema from the connection overview.
					</Banner>
				</div>
			</div>
		);
	}

	// Without a primary key AND without a user sort, the page SELECT carries no
	// ORDER BY at all, and SQL does not promise a stable row order between
	// calls — rows can repeat or vanish across pages. Say so rather than let
	// the pager look authoritative.
	const unordered = (tableDef.primary_key ?? []).length === 0 && gridSort.length === 0;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={table}
				subtitle={`${snapshot.schema?.database ?? ''} - browsing via ${endpoint.pipelineName} / ${endpoint.nodeId}`}
			/>

			<div style={styles.body}>
				{loadError && (
					<div style={styles.banner}>
						{/* Clears itself on the next page that loads. */}
						<Banner variant="error">Could not load this page: {loadError}</Banner>
					</div>
				)}
				{unordered && (
					<div style={styles.note}>No primary key: page order is not guaranteed by the database</div>
				)}
				<FilterChips
					columns={tableDef.columns.map((c) => c.column)}
					chips={chips}
					onChipsChange={setChips}
					sort={gridSort}
					onSortChange={handleSortChange}
				/>
				{countNote && (
					<div style={styles.countNote}>
						<span>
							{countNote.kind === 'estimate'
								? `About ${countNote.rows.toLocaleString()} rows (estimate)`
								: 'More rows match. They are not counted because the table is large.'}
						</span>
						<Button variant="ghost" small onClick={countExactly}>Count exactly</Button>
					</div>
				)}
				<Card noBodyPadding fill>
					<DataGrid<Record<string, unknown>>
						ref={gridRef}
						title={table}
						columns={columns}
						fetchPage={env.ready ? fetchPage : undefined}
						remoteSort
						onRowClick={handleRowClick}
						onLoadError={handleLoadError}
						tableId={`sql-data-${endpoint.provider}`}
						persistence={env.gridPersistence}
						height="100%"
						emptyTitle="No rows"
						emptyDescription="The table is empty (or nothing matches the current search/filters)."
					/>
				</Card>
			</div>

			<RecordDrawer
				dialect={dialect}
				graph={graph}
				tables={snapshot.schema?.tables ?? {}}
				table={table}
				rows={openRow?.rows ?? []}
				index={openRow?.index ?? null}
				offset={openRow?.offset ?? 0}
				onIndexChange={(index) => setOpenRow((current) => (current ? { ...current, index } : current))}
				onClose={() => setOpenRow(null)}
				lookup={env.ready && executeAllowed ? lookup : null}
				onShowRows={onOpenTable}
			/>
		</div>
	);
};

export default TableDataView;

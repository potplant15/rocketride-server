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
// SQL-UI — REVIEW SQL, APPLY CONFIRMATION, APPLY RESULT (staged row edits)
// =============================================================================
//
// What the data browser shows between staging and saving:
//
//   ReviewSqlDialog      the exact statements Apply will send, in order, each
//                        with the rows it must change. BEGIN / COMMIT frame
//                        them ONLY when the apply will be one transaction
//                        (PostgreSQL and MySQL, through the node's `begin`
//                        tool); otherwise the words say each statement
//                        commits on its own. Values are shown inline to be
//                        read; Apply binds them.
//   ApplyConfirmDialog   "Apply 3 changes to orders on Shop Postgres?", one
//                        line per change, and whether it is all or none.
//   applyResultText      what the reply says was saved: all, none, some, or
//                        (a commit whose answer never arrived) unknown.
//
// Presentational: statements, flags and handlers come from props; the text
// is built by the pure helpers below, which the tests read.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, ConfirmDialog, Modal } from 'shell';
import type { SqlApplyResult, SqlApplyStatement, SqlDialect } from '../connect';
import type { RowEdits } from '../sql/rowEdits';
import { applyButtonLabel, pendingCountText } from './PendingChangesBar';

// =============================================================================
// APPLY MODE
// =============================================================================

/**
 * How staged row edits are applied on a dialect.
 *
 * @param dialect - The connection's dialect.
 * @returns `atomic`: what Apply asks the engine for; `transactional`: what the
 *          review and the confirmation may promise before the reply (the
 *          same: PostgreSQL and MySQL run them through the node's `begin`).
 */
export function rowEditApplyMode(dialect: SqlDialect): { atomic: boolean; transactional: boolean } {
	const atomic = dialect === 'postgres' || dialect === 'mysql';
	return { atomic, transactional: atomic };
}

// =============================================================================
// WORDING
// =============================================================================

/**
 * A count of something, singular or plural.
 *
 * @param n - The count.
 * @param one - The singular noun.
 * @param many - The plural.
 * @returns `1 change`, `3 changes`.
 */
function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Review SQL's opening sentence.
 *
 * @param transactional - Whether the apply will be one transaction.
 * @returns The sentence.
 */
export function reviewIntroText(transactional: boolean): string {
	return transactional
		? 'These statements run in one transaction. If any fails, none are applied and your edits stay staged.'
		: 'Each statement runs and commits on its own. If one fails, the ones before it stay applied and the rest are not run.';
}

/**
 * The statements and the rows they must change: `3 statements · 3 rows`.
 *
 * @param statements - The statements.
 * @returns The summary (rows only when every statement expects a count).
 */
export function reviewSummaryText(statements: readonly SqlApplyStatement[]): string {
	const head = count(statements.length, 'statement', 'statements');
	if (!statements.every((statement) => statement.expect !== undefined)) return head;
	const rows = statements.reduce((sum, statement) => sum + (statement.expect ?? 0), 0);
	return `${head} · ${count(rows, 'row', 'rows')}`;
}

/**
 * One label per staged change, in statement order: `1 row · edited`.
 *
 * @param edits - The staged row edits.
 * @returns The labels.
 */
export function rowStatementLabels(edits: RowEdits): string[] {
	const what = { update: 'edited', insert: 'new', delete: 'deleted' } as const;
	return edits.entries.map((edit) => `1 row · ${what[edit.kind]}`);
}

/**
 * A value as a SQL literal of the dialect, for reading only (Apply binds it).
 *
 * @param value - The bound value.
 * @param dialect - The dialect (MySQL and ClickHouse read a backslash as an escape).
 * @returns The literal.
 */
export function sqlLiteral(value: unknown, dialect: SqlDialect): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number') return String(value);
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	const escaped = dialect === 'mysql' || dialect === 'clickhouse' ? text.replace(/\\/g, '\\\\') : text;
	return `'${escaped.replace(/'/g, "''")}'`;
}

/**
 * A statement with its bound values shown in place of `$1..$n`. Placeholders
 * inside quoted text or quoted names are left alone, as the node's own
 * rewriting leaves them.
 *
 * @param statement - The statement.
 * @param dialect - The dialect.
 * @returns The text to read.
 */
export function previewSql(statement: SqlApplyStatement, dialect: SqlDialect): string {
	const params = statement.params ?? [];
	if (params.length === 0) return statement.sql;
	const sql = statement.sql;
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] as string;
		if (quote !== null) {
			out += ch;
			// A doubled quote stays inside; a single one ends the quoted run.
			if (ch === quote) {
				if (sql[i + 1] === quote) {
					out += quote;
					i++;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			out += ch;
			continue;
		}
		const digits = ch === '$' ? /^\d+/.exec(sql.slice(i + 1))?.[0] : undefined;
		const n = digits === undefined ? 0 : Number(digits);
		if (n >= 1 && n <= params.length) {
			out += sqlLiteral(params[n - 1], dialect);
			i += (digits as string).length;
			continue;
		}
		out += ch;
	}
	return out;
}

/** The line that opens a transactional apply in the review. */
const BEGIN_LINE = "BEGIN; -- through the node's begin tool";

/**
 * The line that closes a transactional apply in the review.
 *
 * @param total - How many statements it holds.
 * @returns `COMMIT; -- all 3, or none`.
 */
function commitLine(total: number): string {
	return total === 1 ? 'COMMIT;' : `COMMIT; -- all ${total}, or none`;
}

/**
 * The whole apply as one script, for reading and for Copy SQL: framed by
 * BEGIN / COMMIT only when it will run as one transaction.
 *
 * @param statements - The statements.
 * @param dialect - The dialect.
 * @param transactional - Whether the apply will be one transaction.
 * @returns The script, one statement per line.
 */
export function reviewScript(statements: readonly SqlApplyStatement[], dialect: SqlDialect, transactional: boolean): string {
	const body = statements.map((statement) => `${previewSql(statement, dialect)};`);
	return (transactional ? [BEGIN_LINE, ...body, commitLine(statements.length)] : body).join('\n');
}

/**
 * The Apply confirmation's title.
 *
 * @param total - How many changes.
 * @returns `Apply 3 changes?`
 */
export function applyConfirmTitle(total: number): string {
	return `${applyButtonLabel(total)}?`;
}

/** What the Apply confirmation needs to know. */
export interface ApplyConfirmFacts {
	/** How many changes. */
	total: number;
	/** The table. */
	table: string;
	/** The connection's name. */
	connection: string;
	/** Whether the apply will be one transaction. */
	transactional: boolean;
	/** How many of the changes are deletes. */
	deletes: number;
}

/**
 * The Apply confirmation's two sentences: what runs where, and what happens
 * if one change fails.
 *
 * @param facts - See {@link ApplyConfirmFacts}.
 * @returns The lead and the note.
 */
export function applyConfirmParts(facts: ApplyConfirmFacts): { lead: string; note: string } {
	const { total, table, connection, transactional, deletes } = facts;
	const lead = `Apply ${count(total, 'change', 'changes')} to ${table} on ${connection}?`;
	let note: string;
	if (transactional) {
		note = total === 1 ? 'It runs in one transaction.' : `They run together in one transaction: all ${total} are saved, or none.`;
	} else {
		note = total === 1 ? 'It commits on its own.' : 'Each change commits on its own. If one fails, the ones before it stay applied.';
	}
	if (deletes > 0) note += ' A delete cannot be undone after it commits.';
	return { lead, note };
}

/**
 * The Apply confirmation as one text (also what a screen reader is told).
 *
 * @param facts - See {@link ApplyConfirmFacts}.
 * @returns The text.
 */
export function applyConfirmText(facts: ApplyConfirmFacts): string {
	const { lead, note } = applyConfirmParts(facts);
	return `${lead} ${note}`;
}

/** What an apply's outcome banner says. */
export interface ApplyResultText {
	/** Banner severity. */
	variant: 'info' | 'warning' | 'error';
	/** The first line: what is saved. */
	title: string;
	/** The app's own sentences. */
	detail: string;
	/** The database's (or node's) words, verbatim, for a "Database said" block; null when there are none. */
	message: string | null;
}

/**
 * Format a time as HH:MM.
 *
 * @param ms - Unix milliseconds.
 * @returns The local time.
 */
function clockTime(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What an apply's reply says was saved.
 *
 * @param result - The reply (SqlSession.applyStatements).
 * @param facts - How many changes were sent, to which table, and when it finished.
 * @param facts.total - How many changes were sent.
 * @param facts.table - The table.
 * @param facts.at - When the reply arrived (Unix ms).
 * @returns The banner text.
 */
export function applyResultText(result: SqlApplyResult, facts: { total: number; table: string; at: number }): ApplyResultText {
	const { total, table, at } = facts;
	const failure = result.failure;
	if (failure === null) {
		return {
			variant: 'info',
			title: `${count(total, 'change', 'changes')} applied to ${table}`,
			detail: result.transactional ? `1 transaction · committed ${clockTime(at)}` : `each committed on its own · ${clockTime(at)}`,
			message: null,
		};
	}
	// A row count that did not match is the app's sentence, not the database's.
	const own = failure.stage === 'expect' ? ` ${failure.message}` : '';
	const message = failure.stage === 'expect' ? null : failure.message;
	if (result.transactional) {
		if (failure.stage === 'commit' && failure.unknown) {
			return { variant: 'warning', title: 'The commit\'s answer did not arrive.', detail: 'These changes may or may not be saved. Refresh the table to see what it holds now.', message };
		}
		const what = failure.stage === 'commit' ? 'The commit was refused.' : `Change ${failure.index + 1} of ${total} failed.${own}`;
		return { variant: 'error', title: 'Apply failed. No changes were applied.', detail: `${what} Your edits are still staged.`, message };
	}
	const parts: string[] = [];
	if (own !== '') parts.push(own.trim());
	if (failure.unknown) parts.push(`Change ${failure.index + 1} may have been applied: its answer did not arrive.`);
	const firstNotRun = failure.index + 2;
	if (firstNotRun === total) parts.push(`Change ${total} was not run.`);
	else if (firstNotRun < total) parts.push(`Changes ${firstNotRun}–${total} were not run.`);
	return {
		variant: 'error',
		title: `Apply stopped at change ${failure.index + 1} of ${total}. ${failure.committed} of ${total} applied.`,
		detail: parts.join(' '),
		message,
	};
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	subtitle: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 10,
	} as CSSProperties,

	intro: {
		fontSize: 12.5,
		lineHeight: 1.6,
		marginBottom: 12,
	} as CSSProperties,

	sectionHead: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 6,
	} as CSSProperties,

	script: {
		margin: 0,
		padding: '8px 10px',
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		maxHeight: 320,
		overflow: 'auto',
	} as CSSProperties,

	line: {
		display: 'flex',
		gap: 12,
		alignItems: 'baseline',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: 1.7,
	} as CSSProperties,

	statement: {
		flex: 1,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	frame: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	label: {
		flexShrink: 0,
		fontFamily: 'var(--rr-font-family, inherit)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	bindNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 8,
	} as CSSProperties,

	footer: {
		display: 'flex',
		gap: 8,
		width: '100%',
		flexWrap: 'wrap',
	} as CSSProperties,

	spacer: {
		flex: 1,
	} as CSSProperties,

	confirmList: {
		margin: '10px 0',
		paddingLeft: 18,
		fontSize: 12.5,
		lineHeight: 1.7,
	} as CSSProperties,

	confirmNote: {
		fontSize: 12.5,
		lineHeight: 1.6,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// REVIEW SQL
// =============================================================================

/** Props for the {@link ReviewSqlDialog} component. */
export interface ReviewSqlDialogProps {
	/** The table the changes are for. */
	table: string;
	/** The connection's name. */
	connectionName: string;
	/** The connection's dialect (how values are shown). */
	dialect: SqlDialect;
	/** The statements Apply will send (sql/rowEdits.ts buildRowStatements). */
	statements: SqlApplyStatement[];
	/** One label per statement (rowStatementLabels), or none. */
	labels?: string[];
	/** Whether the apply will be one transaction (rowEditApplyMode). */
	transactional: boolean;
	/** An apply is running. */
	busy?: boolean;
	/** Why Apply cannot run now, or null. */
	applyDisabledReason?: string | null;
	/** Back to editing (also the ✕ and Escape). */
	onClose: () => void;
	/** Apply was chosen (the parent confirms first). */
	onApply: () => void;
	/** Discard all was chosen (the parent asks first when two or more would go). */
	onDiscardAll: () => void;
	/** Copy SQL, given the script (omitted: no Copy button). */
	onCopySql?: (script: string) => void;
	/** Open in a query tab, given the script (omitted: no button). */
	onOpenInQuery?: (script: string) => void;
}

/**
 * The Review SQL dialog: the exact statements, in order, framed by BEGIN /
 * COMMIT only when the apply will be one transaction.
 *
 * @param props - {@link ReviewSqlDialogProps}.
 * @returns The dialog.
 */
export const ReviewSqlDialog: React.FC<ReviewSqlDialogProps> = (props) => {
	const { table, connectionName, dialect, statements, labels = [], transactional, busy = false, applyDisabledReason = null, onClose, onApply, onDiscardAll, onCopySql, onOpenInQuery } = props;
	const script = reviewScript(statements, dialect, transactional);
	const footer = (
		<div style={styles.footer}>
			{onCopySql && <Button variant="ghost" small onClick={() => onCopySql(script)}>Copy SQL</Button>}
			{onOpenInQuery && <Button variant="ghost" small onClick={() => onOpenInQuery(script)}>Open in a query tab</Button>}
			<span style={styles.spacer} />
			<Button variant="ghost" small onClick={onDiscardAll} disabled={busy}>Discard all</Button>
			<Button variant="secondary" small onClick={onClose}>Back to editing</Button>
			<Button
				variant="primary"
				small
				onClick={onApply}
				disabled={busy || applyDisabledReason !== null || statements.length === 0}
				{...(applyDisabledReason !== null ? { title: applyDisabledReason } : {})}
			>
				{busy ? 'Applying...' : applyButtonLabel(statements.length)}
			</Button>
		</div>
	);
	return (
		<Modal title="Review SQL" onClose={onClose} footer={footer} width={720}>
			<div style={styles.subtitle}>{pendingCountText(statements.length)} to {table} · {connectionName}</div>
			<div style={styles.intro}>{reviewIntroText(transactional)}</div>
			<div style={styles.sectionHead}>
				<span>Statements</span>
				<span>{reviewSummaryText(statements)}</span>
			</div>
			<div style={styles.script} role="list" aria-label="Statements Apply will run">
				{transactional && (
					<div style={{ ...styles.line, ...styles.frame }}>
						<span style={styles.statement}>{BEGIN_LINE}</span>
					</div>
				)}
				{statements.map((statement, i) => (
					<div key={i} style={styles.line} role="listitem">
						<span style={styles.statement}>{previewSql(statement, dialect)};</span>
						{labels[i] && <span style={styles.label}>{labels[i]}</span>}
					</div>
				))}
				{transactional && (
					<div style={{ ...styles.line, ...styles.frame }}>
						<span style={styles.statement}>{commitLine(statements.length)}</span>
					</div>
				)}
			</div>
			<div style={styles.bindNote}>Values are shown in place to be read. Apply sends them separately, bound, never as part of the statement text.</div>
		</Modal>
	);
};

// =============================================================================
// APPLY CONFIRMATION
// =============================================================================

/** Props for the {@link ApplyConfirmDialog} component. */
export interface ApplyConfirmDialogProps extends ApplyConfirmFacts {
	/** One line per change (sql/rowEdits.ts describeRowEdit). */
	lines: string[];
	/** An apply is running. */
	busy?: boolean;
	/** Apply. */
	onConfirm: () => void;
	/** Cancel. */
	onCancel: () => void;
}

/**
 * The Apply confirmation: what runs where, one line per change, and whether
 * it is all or none.
 *
 * @param props - {@link ApplyConfirmDialogProps}.
 * @returns The dialog.
 */
export const ApplyConfirmDialog: React.FC<ApplyConfirmDialogProps> = ({ lines, busy = false, onConfirm, onCancel, ...facts }) => {
	const { lead, note } = applyConfirmParts(facts);
	return (
		<ConfirmDialog
			title={applyConfirmTitle(facts.total)}
			message={
				<>
					<div>{lead}</div>
					<ul style={styles.confirmList}>
						{lines.map((line, i) => <li key={i}>{line} · 1 row</li>)}
					</ul>
					<div style={styles.confirmNote}>{note}</div>
				</>
			}
			confirmLabel={busy ? 'Applying...' : applyButtonLabel(facts.total)}
			destructive={facts.deletes > 0}
			confirmDisabled={busy}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
};

export default ReviewSqlDialog;

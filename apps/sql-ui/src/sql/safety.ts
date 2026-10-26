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
// SQL — SAFETY (which statements ask first, and what they ask)
// =============================================================================
//
// A connection's safety level (connect/savedConnections.ts) decides which
// statements ask before they are sent:
//
//   - `off`   — none.
//   - `risky` — the shapes the pattern check flags (classify.ts): UPDATE or
//               DELETE without WHERE or inside a WITH clause, TRUNCATE, DROP,
//               ALTER.
//   - `every` — any statement that writes rows or changes the schema (the
//               `write` and `ddl` kinds), and everything `risky` flags.
//
// At `risky` and `every`, DROP and TRUNCATE also ask for the target's name to
// be typed, exactly as the statement spells it (GitHub's pattern for deleting
// a repository). Several targets, or a name this cannot read, ask for the verb.
//
// The dialog can also say how many rows a write would change. The number is
// the planner's estimate from a plain EXPLAIN, which plans without running:
// PostgreSQL's `Plan Rows` and MySQL's `rows`. ClickHouse, and anything else
// those two cannot explain, gets no estimate.
//
// Everything here reads the statement TEXT. It prevents nothing the database
// would do on its own, and the dialog says so.
// =============================================================================

import type { IPatternFinding } from 'shared/explorer/runner/types';
import type { SqlDialect } from '../connect';
import type { SafetyLevel } from '../connect/savedConnections';
import { leadingVerb } from './batch';
import { classifyStatement, patternCheck } from './classify';
import { buildExplain } from './explain';
import { stripSqlComments } from './split';

// =============================================================================
// TYPES
// =============================================================================

/** What a DROP or a TRUNCATE removes, and what must be typed to confirm it. */
export interface DestructiveTarget {
	/** The statement's verb. */
	verb: 'DROP' | 'TRUNCATE';
	/** What is removed, in lower case: `table`, `view`, `database`… (`table` for TRUNCATE). */
	object: string;
	/**
	 * Every target as written, quotes removed and schema kept (`public.orders`).
	 * Empty when the names could not be read.
	 */
	names: string[];
	/** What the user types: the one target's own name, or the verb when there are several or none could be read. */
	confirmText: string;
}

/** Why a statement asks before it is sent. */
export interface WriteConfirmation extends IPatternFinding {
	/**
	 * What was seen: the pattern check's shape (`UPDATE without WHERE`,
	 * `DROP`…), or at `every` the statement's kind (`a write`, `a schema change`).
	 */
	kind: string;
	/** The connection's level that asked. */
	level: Exclude<SafetyLevel, 'off'>;
	/** For DROP and TRUNCATE: the target whose name must be typed. */
	target: DestructiveTarget | null;
}

/** The affected-row estimate, as the dialog shows it. */
export type RowEstimate = { state: 'estimating' } | { state: 'rows'; rows: number } | { state: 'none' };

/** The dialog's sentences for one confirmation. */
export interface WriteConfirmCopy {
	/** The dialog title, a question naming the action. */
	title: string;
	/** What the statement does, in plain words. */
	consequence: string;
	/** How it runs. */
	runsAs: string;
	/** Why the dialog was shown. */
	why: string;
	/** The confirm button, repeating the action. */
	confirmLabel: string;
}

// =============================================================================
// THE RULE
// =============================================================================

/**
 * Whether a statement asks before it is sent at a connection's level, and why.
 *
 * @param sql - The statement as it would be sent.
 * @param dialect - The engine dialect.
 * @param level - The connection's safety level.
 * @returns The confirmation to show, or null when the statement runs at once.
 */
export function needsConfirmation(sql: string, dialect: SqlDialect, level: SafetyLevel): WriteConfirmation | null {
	if (level === 'off') return null;
	const target = destructiveTarget(sql, dialect);
	const finding = patternCheck(sql, dialect);
	if (finding) return { kind: finding.kind, level, target };
	if (level === 'every') {
		const kind = classifyStatement(sql, dialect);
		if (kind === 'write') return { kind: 'a write', level, target };
		if (kind === 'ddl') return { kind: 'a schema change', level, target };
	}
	return null;
}

/**
 * Whether a runner finding is one {@link needsConfirmation} made.
 *
 * @param finding - The finding the runner hands back.
 * @returns True when it carries a level.
 */
export function isWriteConfirmation(finding: IPatternFinding): finding is WriteConfirmation {
	const level = (finding as { level?: unknown }).level;
	return level === 'risky' || level === 'every';
}

/**
 * The confirmation a runner finding stands for. Every finding the query view
 * gets comes from {@link needsConfirmation}; anything else is shown as a
 * risky write without a typed name rather than left unanswered.
 *
 * @param finding - The finding the runner hands back.
 * @returns The confirmation.
 */
export function toWriteConfirmation(finding: IPatternFinding): WriteConfirmation {
	return isWriteConfirmation(finding) ? finding : { kind: finding.kind, level: 'risky', target: null };
}

/**
 * Whether the typed text confirms a target. The match is EXACT: case
 * sensitive, and nothing is trimmed, so the user types what the dialog shows.
 *
 * @param typed - What the user typed.
 * @param target - The target.
 * @returns True when the confirm button may be used.
 */
export function confirmTextMatches(typed: string, target: DestructiveTarget): boolean {
	return typed === target.confirmText;
}

// =============================================================================
// DROP AND TRUNCATE TARGETS
// =============================================================================

/** DROP object kinds whose names are read, longest spelling first. */
const DROP_OBJECTS: string[][] = [
	['materialized', 'view'],
	['foreign', 'table'],
	['table'],
	['view'],
	['index'],
	['schema'],
	['database'],
	['sequence'],
	['dictionary'],
];

/** A character that can start an unquoted identifier. */
const IDENT_START = /[A-Za-z_\u0080-￿]/;

/** A character that can continue an unquoted identifier. */
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** A read position in comment-free statement text. */
interface Cursor {
	/** The text. */
	text: string;
	/** The current offset. */
	at: number;
}

/**
 * Skip whitespace.
 *
 * @param cursor - The read position.
 */
function skipSpace(cursor: Cursor): void {
	while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at] as string)) cursor.at += 1;
}

/**
 * Consume a sequence of keywords, case-insensitively and as whole words; the
 * cursor does not move unless all of them match.
 *
 * @param cursor - The read position.
 * @param words - The keywords, in order.
 * @returns True when they were consumed.
 */
function takeWords(cursor: Cursor, ...words: string[]): boolean {
	const start = cursor.at;
	for (const word of words) {
		skipSpace(cursor);
		const next = cursor.text.slice(cursor.at, cursor.at + word.length);
		const after = cursor.text[cursor.at + word.length];
		if (next.toLowerCase() !== word || (after !== undefined && IDENT_PART.test(after))) {
			cursor.at = start;
			return false;
		}
		cursor.at += word.length;
	}
	return true;
}

/**
 * Read one bare word, without consuming it.
 *
 * @param cursor - The read position.
 * @returns The word, or null when an identifier does not start here.
 */
function peekWord(cursor: Cursor): string | null {
	const probe = { ...cursor };
	skipSpace(probe);
	if (!IDENT_START.test(probe.text[probe.at] ?? '')) return null;
	let end = probe.at;
	while (end < probe.text.length && IDENT_PART.test(probe.text[end] as string)) end += 1;
	return probe.text.slice(probe.at, end);
}

/**
 * Read one name part: a quoted identifier (its quotes removed, a doubled
 * quote undone) or a bare one (as written).
 *
 * @param cursor - The read position.
 * @param dialect - The engine dialect (backticks quote on MySQL and ClickHouse).
 * @returns The part, or null when no identifier starts here.
 */
function namePart(cursor: Cursor, dialect: SqlDialect): string | null {
	skipSpace(cursor);
	const open = cursor.text[cursor.at];
	const quotes = dialect === 'postgres' ? ['"'] : ['"', '`'];
	if (open !== undefined && quotes.includes(open)) {
		let out = '';
		let at = cursor.at + 1;
		while (at < cursor.text.length) {
			const ch = cursor.text[at] as string;
			if (ch === open) {
				if (cursor.text[at + 1] === open) {
					out += open;
					at += 2;
					continue;
				}
				cursor.at = at + 1;
				return out;
			}
			out += ch;
			at += 1;
		}
		return null;
	}
	const word = peekWord(cursor);
	if (word === null) return null;
	skipSpace(cursor);
	cursor.at += word.length;
	return word;
}

/**
 * Read a list of possibly qualified names separated by commas.
 *
 * @param cursor - The read position.
 * @param dialect - The engine dialect.
 * @param star - Whether a name may carry PostgreSQL's trailing `*` (TRUNCATE).
 * @returns Each name as its parts, or null when the list could not be read.
 */
function nameList(cursor: Cursor, dialect: SqlDialect, star: boolean): string[][] | null {
	const names: string[][] = [];
	for (;;) {
		const parts: string[] = [];
		for (;;) {
			const part = namePart(cursor, dialect);
			if (part === null) return null;
			parts.push(part);
			skipSpace(cursor);
			if (cursor.text[cursor.at] !== '.') break;
			cursor.at += 1;
		}
		names.push(parts);
		skipSpace(cursor);
		if (star && cursor.text[cursor.at] === '*') {
			cursor.at += 1;
			skipSpace(cursor);
		}
		if (cursor.text[cursor.at] !== ',') return names;
		cursor.at += 1;
	}
}

/**
 * What a DROP or a TRUNCATE removes, read from the statement text.
 *
 * Reads past comments (with the dialect's rules), `TEMPORARY`, `IF EXISTS`,
 * `CONCURRENTLY` and `ONLY`; strips quotes from quoted names and keeps the
 * schema of a qualified one. A DROP of something other than a table, view,
 * materialized view, foreign table, index, schema, database, sequence or
 * dictionary (a function with its argument list, a role…) is reported with no
 * names, and is confirmed by typing the verb.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns The target, or null when the statement is not a DROP or a TRUNCATE.
 */
export function destructiveTarget(sql: string, dialect: SqlDialect = 'unknown'): DestructiveTarget | null {
	const cursor: Cursor = { text: stripSqlComments(sql, dialect).trim(), at: 0 };
	let verb: DestructiveTarget['verb'];
	let object = 'table';
	let names: string[][] | null = null;

	if (takeWords(cursor, 'drop')) {
		verb = 'DROP';
		if (!takeWords(cursor, 'temporary')) takeWords(cursor, 'temp');
		const known = DROP_OBJECTS.find((words) => takeWords(cursor, ...words));
		if (known) {
			object = known.join(' ');
			if (object === 'index') takeWords(cursor, 'concurrently');
			takeWords(cursor, 'if', 'exists');
			names = nameList(cursor, dialect, false);
		} else {
			object = peekWord(cursor)?.toLowerCase() ?? 'object';
		}
	} else if (takeWords(cursor, 'truncate')) {
		verb = 'TRUNCATE';
		if (takeWords(cursor, 'database')) object = 'database';
		else takeWords(cursor, 'table');
		// ClickHouse's `TRUNCATE ALL TABLES FROM db` names no table.
		if (!takeWords(cursor, 'all', 'tables')) {
			takeWords(cursor, 'if', 'exists');
			takeWords(cursor, 'only');
			names = nameList(cursor, dialect, true);
		}
	} else {
		return null;
	}

	const read = names ?? [];
	const only = read.length === 1 ? read[0] : undefined;
	return {
		verb,
		object,
		names: read.map((parts) => parts.join('.')),
		confirmText: only ? only[only.length - 1] as string : verb,
	};
}

// =============================================================================
// AFFECTED-ROW ESTIMATE
// =============================================================================

/** Statements the estimate explains: the writes PostgreSQL and MySQL plan. */
const ESTIMATED_VERBS = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'MERGE']);

/**
 * The plain EXPLAIN whose plan estimates how many rows a write changes, or
 * null when there is none to ask for.
 *
 * PostgreSQL gets the JSON plan; MySQL the classic table, whose `rows` and
 * `filtered` columns are documented for UPDATE and DELETE. Neither runs the
 * statement (no ANALYZE), and the gate classifies both as reads. ClickHouse,
 * an unknown dialect, DDL, TRUNCATE (which PostgreSQL cannot explain) and a
 * WITH chain (whose plan root is not the write) get none.
 *
 * @param sql - The statement as it would be sent.
 * @param dialect - The engine dialect.
 * @returns The EXPLAIN statement, or null.
 */
export function rowEstimateStatement(sql: string, dialect: SqlDialect): string | null {
	if (dialect !== 'postgres' && dialect !== 'mysql') return null;
	if (classifyStatement(sql, dialect) !== 'write' || !ESTIMATED_VERBS.has(leadingVerb(sql, dialect))) return null;
	if (dialect === 'postgres') return buildExplain(dialect, sql);
	const body = sql.replace(/\s*;\s*$/, '').trim();
	return body ? `EXPLAIN ${body}` : null;
}

/**
 * A planner number, from a JSON number or the numeric text MySQL sends.
 *
 * @param value - The raw value.
 * @returns The number, or null.
 */
function plannerNumber(value: unknown): number | null {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Read PostgreSQL's estimate: the rows the write's input plan produces. A
 * `ModifyTable` root reports 0 rows on newer servers, so its first child (the
 * scan that finds the rows) is read instead.
 *
 * @param rows - The EXPLAIN (FORMAT JSON) result rows.
 * @returns The estimate, or null.
 */
function postgresEstimate(rows: Record<string, unknown>[]): number | null {
	const first = rows[0];
	let doc: unknown = first?.['QUERY PLAN'] ?? first?.['query plan'];
	if (typeof doc === 'string') {
		try {
			doc = JSON.parse(doc);
		} catch {
			return null;
		}
	}
	const entry = Array.isArray(doc) ? doc[0] : doc;
	const plan = (entry as { Plan?: Record<string, unknown> } | null)?.Plan;
	if (!plan || typeof plan !== 'object') return null;
	const children = Array.isArray(plan.Plans) ? plan.Plans as Record<string, unknown>[] : [];
	const source = plan['Node Type'] === 'ModifyTable' && children[0] ? children[0] : plan;
	return plannerNumber(source['Plan Rows']);
}

/**
 * Read MySQL's estimate from the classic EXPLAIN table: the target table's
 * row (its `select_type` is the verb), `rows` scaled by `filtered` percent.
 *
 * @param rows - The EXPLAIN result rows.
 * @returns The estimate, or null.
 */
function mysqlEstimate(rows: Record<string, unknown>[]): number | null {
	const target = rows.find((row) => typeof row.select_type === 'string' && ESTIMATED_VERBS.has(row.select_type.toUpperCase())) ?? rows[0];
	const examined = plannerNumber(target?.rows);
	if (examined === null) return null;
	const filtered = plannerNumber(target?.filtered);
	return Math.round(filtered === null ? examined : (examined * filtered) / 100);
}

/**
 * Read the affected-row estimate out of an estimate EXPLAIN's result.
 *
 * @param dialect - The engine dialect.
 * @param rows - The EXPLAIN result rows.
 * @returns The estimate, or null when the plan does not give one.
 */
export function parseRowEstimate(dialect: SqlDialect, rows: Record<string, unknown>[]): number | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	if (dialect === 'postgres') return postgresEstimate(rows);
	if (dialect === 'mysql') return mysqlEstimate(rows);
	return null;
}

/**
 * The dialog's "Rows that change" value, or null when the line does not
 * apply (schema changes other than TRUNCATE).
 *
 * @param confirmation - Why the statement asks.
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @param estimate - Where the estimate is.
 * @returns The text, or null.
 */
export function rowsChangeText(confirmation: WriteConfirmation, sql: string, dialect: SqlDialect, estimate: RowEstimate): string | null {
	if (confirmation.target?.verb === 'TRUNCATE') return 'Every row';
	if (classifyStatement(sql, dialect) !== 'write') return null;
	if (estimate.state === 'estimating') return 'Estimating…';
	if (estimate.state === 'none') return 'No estimate';
	return `about ${estimate.rows.toLocaleString()} ${estimate.rows === 1 ? 'row' : 'rows'} (planner estimate)`;
}

// =============================================================================
// WORDING
// =============================================================================

/**
 * What the statement does, for a confirmation without a DROP or TRUNCATE target.
 *
 * @param kind - The confirmation's kind.
 * @returns The sentence.
 */
function plainConsequence(kind: string): string {
	if (kind === 'UPDATE without WHERE') return 'No WHERE clause: this changes every row in the table.';
	if (kind === 'DELETE without WHERE') return 'No WHERE clause: this deletes every row in the table.';
	const inWith = /^(UPDATE|DELETE) inside a WITH clause$/.exec(kind);
	if (inWith) return `A WITH clause in it runs ${inWith[1]}; this check cannot tell which rows that reaches.`;
	if (kind === 'ALTER' || kind === 'a schema change') return 'It changes the schema.';
	return 'It changes data.';
}

/**
 * The dialog's sentences for one confirmation.
 *
 * @param confirmation - Why the statement asks.
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @param connection - The connection's name.
 * @returns The sentences.
 */
export function writeConfirmCopy(confirmation: WriteConfirmation, sql: string, dialect: SqlDialect, connection: string): WriteConfirmCopy {
	const why = `${connection} is set to ask before ${confirmation.level === 'every' ? 'every write' : 'risky writes'}. This is a check on the statement text, not a database permission.`;
	const runsAs = 'It runs at once and commits on its own. It cannot be undone here.';
	const { target } = confirmation;
	const undo = 'This cannot be undone from SQL Explorer.';
	if (target?.verb === 'DROP') {
		const several = target.names.length > 1;
		const named = target.names.length > 0 ? ` ${target.names.join(', ')}` : '';
		const rows = target.object === 'table' ? (several ? ' and every row in them' : ' and every row in it') : '';
		return {
			title: `Drop ${target.object}${named}?`,
			consequence: `Deletes ${several ? `all ${target.names.length} of them` : `the ${target.object}`}${rows}. ${undo}`,
			runsAs,
			why,
			confirmLabel: several ? `Drop all ${target.names.length}` : `Drop ${target.object}`,
		};
	}
	if (target?.verb === 'TRUNCATE') {
		const several = target.names.length > 1;
		const named = target.names.length > 0 ? ` ${target.names.join(', ')}` : '';
		return {
			title: `Empty ${target.object}${several ? 's' : ''}${named}?`,
			consequence: `Deletes every row in ${target.names.length === 1 ? target.names[0] : 'each table'}; the table structure stays. ${undo}`,
			runsAs,
			why,
			confirmLabel: `Empty ${target.object}${several ? 's' : ''}`,
		};
	}
	const verb = leadingVerb(sql, dialect);
	return {
		title: `Run this ${verb}?`,
		consequence: plainConsequence(confirmation.kind),
		runsAs,
		why,
		confirmLabel: `Run ${verb}`,
	};
}

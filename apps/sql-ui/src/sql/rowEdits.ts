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
// SQL — ROW EDITS (staged grid changes -> bound UPDATE / INSERT / DELETE)
// =============================================================================
//
// The data browser never writes as you edit: every edit, new row and delete
// is staged here, and Apply sends the statements this module builds, as one
// transaction where the engine has one (SqlSession.applyBatch). Pure
// and immutable: every function returns a new RowEdits and never writes to
// the row object it was given (a grid row is Tabulator's to mutate; PLAN-MAP
// fact 4), so React state can hold it as is.
//
//   KEYED BY PRIMARY KEY. A row is named by its key values, never by its
//   position, so a refetch or a page change cannot point an edit at another
//   row. A table without a primary key cannot be edited: nothing could pick
//   out one row exactly. Key columns are read-only.
//
//   EXACT KEYS. A 64-bit key travels as text: JavaScript numbers are exact
//   only up to 2^53, so a key that already arrived as a larger number may
//   have been rounded to ANOTHER row's key, and such a row is refused rather
//   than risked. Every statement expects to change exactly one row, which is
//   what catches a key that matched nothing, or more than one row.
//
//   TYPED VALUES. A form gives text; the reflected column type decides what
//   is bound: a number (or exact text, for an integer beyond 2^53 or a long
//   decimal), a boolean, or the text itself. Values are always bound as
//   `$1..$n`, never written into the statement; only identifiers are, quoted
//   for the dialect.
//
//   INSERTS omit empty fields, so the database's default applies; NULL is
//   sent only when the form says NULL.
//
// PostgreSQL and MySQL only. ClickHouse has no unique keys and runs UPDATE
// and DELETE as background mutations that report no row count, so it is
// refused with the reason, as is an engine that did not report its type.
// =============================================================================

import type { SqlApplyStatement, SqlDialect, SqlSchemaTable } from '../connect';
import { quoteIdent } from './paging';
import { rrTypeFromSqlType } from './resultTypes';

// =============================================================================
// TYPES
// =============================================================================

/** A row's values, by column name. */
export type RowValues = Readonly<Record<string, unknown>>;

/** What the edits are made to. */
export interface RowEditTarget {
	/** The connection's dialect. */
	dialect: SqlDialect;
	/** The table's name. */
	table: string;
	/** The table's reflected schema (columns, types, primary key). */
	def: SqlSchemaTable;
}

/** One staged change. */
export type RowEdit =
	/** Changed fields of an existing row. */
	| { kind: 'update'; key: string; pk: RowValues; changes: RowValues; was: RowValues }
	/** A new row (`key` is local: `new:<n>`). */
	| { kind: 'insert'; key: string; values: RowValues }
	/** An existing row to delete. */
	| { kind: 'delete'; key: string; pk: RowValues };

/** The staged changes of one table, in staging order. */
export interface RowEdits {
	/** The changes; at most one per row key. */
	readonly entries: readonly RowEdit[];
	/** The number the next new row's key takes. */
	readonly nextInsert: number;
}

/** Whether a table can be edited here. */
export type RowEditability = { editable: true; pk: string[] } | { editable: false; reason: string };

/** The outcome of typing one value. */
export type CoercedValue = { ok: true; value: unknown } | { ok: false; reason: string };

/** A change the model refuses; `message` is the reason, written for the user. */
export class RowEditError extends Error {
	/**
	 * @param message - The reason.
	 */
	constructor(message: string) {
		super(message);
		this.name = 'RowEditError';
	}
}

// =============================================================================
// TYPES OF VALUES
// =============================================================================

/** An integer written as text. */
const INTEGER_TEXT = /^[+-]?\d+$/;

/** A decimal or exponent number written as text. */
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The most significant digits a JavaScript number holds exactly. */
const EXACT_DIGITS = 15;

/** Column types that hold 64 bits or more, whose keys travel as text. */
const WIDE_INTEGER = /\b(?:bigint|int8|bigserial|serial8|u?int(?:64|128|256))\b/i;

/** Spellings of true and false a form may send. */
const TRUE_TEXT = /^(?:true|t|yes|y|on|1)$/i;
const FALSE_TEXT = /^(?:false|f|no|n|off|0)$/i;

/**
 * A number from text: a JavaScript number when that is exact, else the text
 * itself (the database reads it exactly).
 *
 * @param text - The trimmed text.
 * @returns The value, or undefined when the text is not a number.
 */
function numberFromText(text: string): number | string | undefined {
	if (INTEGER_TEXT.test(text)) {
		const value = Number(text);
		return Number.isSafeInteger(value) ? value : text;
	}
	if (!DECIMAL_TEXT.test(text)) return undefined;
	const digits = text.replace(/^[+-]/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
	return digits.length <= EXACT_DIGITS ? Number(text) : text;
}

/**
 * Type one value for a column (from a form field or from the row itself).
 *
 * @param sqlType - The column's reflected type.
 * @param raw - The value: text from a form, or a value the database returned; null is NULL.
 * @returns The value to bind, or the reason it cannot be.
 */
export function coerceValue(sqlType: string, raw: unknown): CoercedValue {
	if (raw === null) return { ok: true, value: null };
	const kind = rrTypeFromSqlType(sqlType);
	if (kind === 'number') {
		if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
		const value = typeof raw === 'string' ? numberFromText(raw.trim()) : undefined;
		return value === undefined ? { ok: false, reason: 'needs a number' } : { ok: true, value };
	}
	if (kind === 'boolean') {
		if (typeof raw === 'boolean') return { ok: true, value: raw };
		const text = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
		if (TRUE_TEXT.test(text)) return { ok: true, value: true };
		if (FALSE_TEXT.test(text)) return { ok: true, value: false };
		return { ok: false, reason: 'needs true or false' };
	}
	if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: raw };
	// A JSON value a driver handed back as an object: sent as its text.
	return { ok: true, value: JSON.stringify(raw) };
}

// =============================================================================
// TABLES AND KEYS
// =============================================================================

/**
 * Whether a table can be edited here, and if not, why.
 *
 * @param dialect - The connection's dialect.
 * @param def - The table's reflected schema (null: not known).
 * @returns The key columns, or the reason.
 */
export function rowEditability(dialect: SqlDialect, def: SqlSchemaTable | null | undefined): RowEditability {
	if (dialect === 'clickhouse') {
		return { editable: false, reason: 'ClickHouse has no unique row keys, and it runs UPDATE and DELETE as background mutations, so rows cannot be edited here. Use the Query page.' };
	}
	if (dialect !== 'postgres' && dialect !== 'mysql') {
		return { editable: false, reason: 'The database did not report its type, so rows cannot be edited here.' };
	}
	const pk = def?.primary_key ?? [];
	if (!def || pk.length === 0) {
		return { editable: false, reason: 'This table has no primary key, so a row cannot be picked out exactly. Rows can be edited only in tables with a primary key.' };
	}
	return { editable: true, pk: [...pk] };
}

/**
 * The key columns of an editable target.
 *
 * @param target - The table.
 * @returns The key column names.
 * @throws RowEditError with the reason when the table cannot be edited.
 */
function keyColumns(target: RowEditTarget): string[] {
	const editability = rowEditability(target.dialect, target.def);
	if (!editability.editable) throw new RowEditError(editability.reason.replace(/^This table/, target.table));
	return editability.pk;
}

/**
 * A column's reflected type.
 *
 * @param target - The table.
 * @param column - The column.
 * @returns Its type.
 * @throws RowEditError when the table has no such column.
 */
function typeOf(target: RowEditTarget, column: string): string {
	const found = target.def.columns.find((c) => c.column === column);
	if (!found) throw new RowEditError(`${target.table} has no column ${column}.`);
	return found.type;
}

/**
 * The value one key column binds, exact.
 *
 * @param target - The table.
 * @param column - The key column.
 * @param value - The row's value in it.
 * @returns The value to bind (text for a 64-bit integer column).
 * @throws RowEditError when the value is missing or may have lost precision.
 */
function keyValue(target: RowEditTarget, column: string, value: unknown): string | number | boolean {
	if (value === null || value === undefined) throw new RowEditError(`This row has no value in its key column ${column}, so it cannot be changed here.`);
	const wide = WIDE_INTEGER.test(typeOf(target, column));
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new RowEditError(`This row's key ${column} (${value}) is larger than this app can hold exactly, so the row cannot be changed here. Use the Query page.`);
		}
		return wide ? String(value) : value;
	}
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	throw new RowEditError(`This row's key ${column} is not a value this app can match exactly, so the row cannot be changed here.`);
}

/**
 * A row's key values, exact.
 *
 * @param target - The table.
 * @param row - The row (by column name).
 * @returns Key column -> bound value.
 */
function keyValues(target: RowEditTarget, row: RowValues): RowValues {
	return Object.fromEntries(keyColumns(target).map((column) => [column, keyValue(target, column, row[column])]));
}

/**
 * The stable name of a row: its key values (a number and its text are the same key).
 *
 * @param target - The table.
 * @param row - The row.
 * @returns The key.
 * @throws RowEditError when the table cannot be edited or the row's key is not exact.
 */
export function rowKey(target: RowEditTarget, row: RowValues): string {
	const pk = keyValues(target, row);
	return JSON.stringify(Object.values(pk).map((value) => String(value)));
}

/**
 * Two values the same for the database's purposes (a number and its text are).
 *
 * @param a - One.
 * @param b - The other.
 * @returns True when equal.
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || a === undefined || b === undefined) return false;
	return typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b);
}

/**
 * Type a set of form fields for the table, dropping what an insert leaves to the default.
 *
 * @param target - The table.
 * @param fields - Column -> raw value.
 * @param forInsert - Omit empty text and undefined (the default applies).
 * @returns Column -> bound value.
 * @throws RowEditError naming the column and its need.
 */
function typedFields(target: RowEditTarget, fields: RowValues, forInsert: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [column, raw] of Object.entries(fields)) {
		const type = typeOf(target, column);
		if (raw === undefined || (forInsert && raw === '')) continue;
		const typed = coerceValue(type, raw);
		if (!typed.ok) throw new RowEditError(`${column} ${typed.reason}.`);
		out[column] = typed.value;
	}
	return out;
}

/**
 * Order a record's columns the way the table orders them.
 *
 * @param target - The table.
 * @param values - Column -> value.
 * @returns The columns present, in table order.
 */
function inTableOrder(target: RowEditTarget, values: RowValues): string[] {
	return target.def.columns.map((c) => c.column).filter((column) => Object.prototype.hasOwnProperty.call(values, column));
}

// =============================================================================
// THE MODEL
// =============================================================================

/**
 * No staged changes.
 *
 * @returns The empty model.
 */
export function emptyRowEdits(): RowEdits {
	return { entries: [], nextInsert: 1 };
}

/**
 * The staged change for a row key, if any.
 *
 * @param edits - The model.
 * @param key - A row key ({@link rowKey}) or a new row's key.
 * @returns The change.
 */
export function pendingOf(edits: RowEdits, key: string): RowEdit | undefined {
	return edits.entries.find((edit) => edit.key === key);
}

/**
 * Replace (in place, keeping its position), add, or remove the change for one key.
 *
 * @param edits - The model.
 * @param key - The key.
 * @param next - The change, or null to remove it.
 * @returns The new model.
 */
function put(edits: RowEdits, key: string, next: RowEdit | null): RowEdits {
	const at = edits.entries.findIndex((edit) => edit.key === key);
	const entries = [...edits.entries];
	if (at === -1) {
		if (next !== null) entries.push(next);
	} else if (next === null) {
		entries.splice(at, 1);
	} else {
		entries[at] = next;
	}
	return { ...edits, entries };
}

/**
 * Stage changed fields of an existing row. Fields set back to the row's own
 * value drop out; a row left with no change is unstaged.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param row - The row as the database returned it.
 * @param changes - Column -> new raw value (text from a form, or null for NULL).
 * @returns The new model.
 * @throws RowEditError with the reason (a key column, a bad value, a row marked for deletion).
 */
export function stageUpdate(edits: RowEdits, target: RowEditTarget, row: RowValues, changes: RowValues): RowEdits {
	const pk = keyColumns(target);
	const key = rowKey(target, row);
	const existing = pendingOf(edits, key);
	if (existing?.kind === 'delete') throw new RowEditError('This row is marked for deletion. Undo that before editing it.');
	for (const column of Object.keys(changes)) {
		typeOf(target, column);
		if (pk.includes(column)) throw new RowEditError(`${column} is part of the key, so it cannot be changed here.`);
	}
	const typed = typedFields(target, changes, false);
	const merged: Record<string, unknown> = { ...(existing?.kind === 'update' ? existing.changes : {}) };
	const was: Record<string, unknown> = { ...(existing?.kind === 'update' ? existing.was : {}) };
	for (const [column, value] of Object.entries(typed)) {
		const original = row[column] ?? null;
		if (sameValue(value, original)) {
			delete merged[column];
			delete was[column];
		} else {
			merged[column] = value;
			was[column] = original;
		}
	}
	if (Object.keys(merged).length === 0) return put(edits, key, null);
	return put(edits, key, { kind: 'update', key, pk: keyValues(target, row), changes: merged, was });
}

/**
 * Stage a new row. Empty fields are left out, so the database's default applies.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param values - Column -> raw value.
 * @returns The new model (the row's key is `new:<n>`).
 * @throws RowEditError with the reason.
 */
export function stageInsert(edits: RowEdits, target: RowEditTarget, values: RowValues): RowEdits {
	keyColumns(target);
	const key = `new:${edits.nextInsert}`;
	const next = put(edits, key, { kind: 'insert', key, values: typedFields(target, values, true) });
	return { ...next, nextInsert: edits.nextInsert + 1 };
}

/**
 * Replace a new row's values before it is applied.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param key - The new row's key.
 * @param values - Column -> raw value (the whole row; empty fields take the default).
 * @returns The new model.
 * @throws RowEditError with the reason, or when there is no such new row.
 */
export function updateInsert(edits: RowEdits, target: RowEditTarget, key: string, values: RowValues): RowEdits {
	keyColumns(target);
	if (pendingOf(edits, key)?.kind !== 'insert') throw new RowEditError('That new row is no longer staged.');
	return put(edits, key, { kind: 'insert', key, values: typedFields(target, values, true) });
}

/**
 * Stage a row's deletion (replacing any edit to it). Deleting a new row just drops it.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param row - The row as the database returned it, or a new row's key.
 * @returns The new model.
 * @throws RowEditError with the reason.
 */
export function stageDelete(edits: RowEdits, target: RowEditTarget, row: RowValues | string): RowEdits {
	keyColumns(target);
	if (typeof row === 'string') {
		if (pendingOf(edits, row)?.kind !== 'insert') throw new RowEditError('That new row is no longer staged.');
		return put(edits, row, null);
	}
	const key = rowKey(target, row);
	return put(edits, key, { kind: 'delete', key, pk: keyValues(target, row) });
}

/**
 * Drop the staged change for one key (undo one row).
 *
 * @param edits - The model.
 * @param key - The key.
 * @returns The new model.
 */
export function unstage(edits: RowEdits, key: string): RowEdits {
	return put(edits, key, null);
}

/**
 * Drop the changes an apply saved before it stopped: the first `committed`
 * ones, since {@link buildRowStatements} sends one statement per change in
 * staging order. After a transaction that rolled back, `committed` is 0 and
 * every change stays staged.
 *
 * @param edits - The model the apply was built from.
 * @param committed - How many statements are saved (SqlApplyFailure.committed).
 * @returns The changes still to apply.
 */
export function dropApplied(edits: RowEdits, committed: number): RowEdits {
	return committed <= 0 ? edits : { ...edits, entries: edits.entries.slice(committed) };
}

/**
 * How many rows each kind of change touches.
 *
 * @param edits - The model.
 * @returns The counts.
 */
export function rowEditCounts(edits: RowEdits): { edited: number; inserted: number; deleted: number; total: number } {
	const count = (kind: RowEdit['kind']): number => edits.entries.filter((edit) => edit.kind === kind).length;
	return { edited: count('update'), inserted: count('insert'), deleted: count('delete'), total: edits.entries.length };
}

// =============================================================================
// STATEMENTS
// =============================================================================

/**
 * The statements Apply sends, one per change in staging order, each bound
 * and expected to change exactly one row.
 *
 * @param edits - The model.
 * @param target - The table.
 * @returns The statements.
 * @throws RowEditError when the table cannot be edited.
 */
export function buildRowStatements(edits: RowEdits, target: RowEditTarget): SqlApplyStatement[] {
	const pk = keyColumns(target);
	const q = (name: string): string => quoteIdent(target.dialect, name);
	const table = q(target.table);
	return edits.entries.map((edit) => {
		const params: unknown[] = [];
		const bind = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		const where = (keys: RowValues): string => pk.map((column) => `${q(column)} = ${bind(keys[column])}`).join(' AND ');
		if (edit.kind === 'update') {
			const set = inTableOrder(target, edit.changes).map((column) => `${q(column)} = ${bind(edit.changes[column])}`).join(', ');
			return { sql: `UPDATE ${table} SET ${set} WHERE ${where(edit.pk)}`, params, expect: 1 };
		}
		if (edit.kind === 'delete') {
			return { sql: `DELETE FROM ${table} WHERE ${where(edit.pk)}`, params, expect: 1 };
		}
		const columns = inTableOrder(target, edit.values);
		if (columns.length === 0) {
			// Every column takes its default.
			const sql = target.dialect === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`;
			return { sql, params, expect: 1 };
		}
		const values = columns.map((column) => bind(edit.values[column])).join(', ');
		return { sql: `INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES (${values})`, params, expect: 1 };
	});
}

// =============================================================================
// WORDING
// =============================================================================

/** Longest value shown in a one-line description. */
const MAX_SHOWN_VALUE = 40;

/**
 * A value as one short line of text.
 *
 * @param value - The value.
 * @returns Its text (NULL for null), shortened.
 */
function shown(value: unknown): string {
	const text = value === null || value === undefined ? 'NULL' : String(value).replace(/\s+/g, ' ');
	return text.length > MAX_SHOWN_VALUE ? `${text.slice(0, MAX_SHOWN_VALUE - 1)}…` : text;
}

/**
 * One line for a change, for the Apply confirmation:
 * `Edit row 5: status pending → paid`, `New row: status pending`, `Delete row 14`.
 *
 * @param edit - The change.
 * @param target - The table.
 * @returns The line.
 */
export function describeRowEdit(edit: RowEdit, target: RowEditTarget): string {
	if (edit.kind === 'insert') {
		const columns = inTableOrder(target, edit.values);
		return columns.length === 0 ? 'New row (every column takes its default)' : `New row: ${columns.map((column) => `${column} ${shown(edit.values[column])}`).join(', ')}`;
	}
	const parts = Object.values(edit.pk).map(shown);
	const row = parts.length === 1 ? `row ${parts[0]}` : `row (${parts.join(', ')})`;
	if (edit.kind === 'delete') return `Delete ${row}`;
	const changes = inTableOrder(target, edit.changes).map((column) => `${column} ${shown(edit.was[column])} → ${shown(edit.changes[column])}`);
	return `Edit ${row}: ${changes.join(', ')}`;
}

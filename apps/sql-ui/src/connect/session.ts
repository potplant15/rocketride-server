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
// CONNECT — SESSION (tool invocation bound to one endpoint)
// =============================================================================
//
// A thin SQL face over the shared tool session
// (shared/explorer/connect/session): it drives the node's shared SQL tools
// (execute / get_schema / refresh_schema / dialect) through the endpoint
// store, which owns the task token. The SqlSession contract is unchanged.
//
// Retry is no longer "a fresh token lookup returned a different token" (task
// tokens are deterministic, so that never fired after a restart). It is the
// shared rule: one retry, idempotent tools only, only on the server's
// TASK_STOPPED code, and only after re-discovery finds the SAME endpoint
// running again. `execute` is repeated only when the caller marks the
// statement a read.
//
// It runs where the engine connection is: the full app's realm, or the dev
// tool's CONTROLLER. A dev-tool frame never holds one (sqlEnv.ts REMOTE).
//
// APPLY is the one place the app opens a transaction: `begin`, every
// statement on the session id it returned, each checked against the rows it
// must change, then `commit`. Anything that goes wrong after `begin` sends
// `rollback` (and never `commit`); none of these is ever sent twice. A node
// that has no `begin` tool runs each statement on its own instead, and the
// result says so. The session id lives only inside one apply call.
//
// Port of f63da6e22 (connect/session.ts).
// =============================================================================

import { ExplorerToolError, isStaleError, readErrorMessage } from 'shared/explorer/errors';
import type { IToolSession } from 'shared/explorer/connect/session';
import type { IGenerationTicket } from 'shared/explorer/generation';
import { APPLY_BUDGET_MS, statementWaitMs } from './tools';
import type {
	SqlApplyFailure,
	SqlApplyResult,
	SqlApplyStatement,
	SqlEndpoint,
	SqlExecuteResult,
	SqlSchemaResponse,
	SqlSession,
	SqlDialect,
} from './types';

// =============================================================================
// DIALECT MAPPING
// =============================================================================

/** Dialect strings this app recognises from the node's `dialect` tool. */
const KNOWN_DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'clickhouse', 'neo4j']);

/**
 * Map a node-reported dialect string onto the app's SqlDialect union.
 *
 * @param value - The raw dialect string from the node.
 * @returns The matching SqlDialect, or 'unknown'.
 */
export function toDialect(value: unknown): SqlDialect {
	return typeof value === 'string' && KNOWN_DIALECTS.has(value) ? (value as SqlDialect) : 'unknown';
}

// =============================================================================
// APPLY HELPERS
// =============================================================================

/**
 * The engine's answer for a tool the node does not have
 * (`data_conn.py` `_tool`: `No handler found for tool "begin" on node "db_1"`).
 */
const UNKNOWN_TOOL = /\bno handler found for tool\b|\bunknown tool\b/i;

/** Below this much of the apply's budget, the next statement is not sent at all. */
const MIN_STATEMENT_WAIT_MS = 1_000;

/**
 * Whether a failed call says the node has no such tool.
 *
 * @param error - What the call threw.
 * @returns True for the engine's no-handler answer (or a local `upgrade` refusal).
 */
function isUnknownTool(error: unknown): boolean {
	return error instanceof ExplorerToolError && (error.kind === 'upgrade' || UNKNOWN_TOOL.test(error.message));
}

/**
 * Whether a failed call is known not to have taken effect: the node (or the
 * server) answered with an error, or nothing was sent. A call the client
 * stopped waiting for, or whose answer was not understood, may have.
 *
 * @param error - What the call threw.
 * @returns True when its outcome is known.
 */
function answeredNo(error: unknown): boolean {
	if (!(error instanceof ExplorerToolError)) return true;
	return error.kind !== 'timeout' && error.kind !== 'malformed' && error.kind !== 'stale';
}

/**
 * A failure record for a call that threw.
 *
 * @param error - What the call threw.
 * @param index - The statement (or, for the commit, the statement count).
 * @param stage - What failed.
 * @param committed - How many statements are saved for certain.
 * @param unknown - Whether the failing call's own outcome is unknown.
 * @returns The record (the message verbatim, the code when there is one).
 */
function failureOf(error: unknown, index: number, stage: SqlApplyFailure['stage'], committed: number, unknown: boolean): SqlApplyFailure {
	const code = error instanceof ExplorerToolError ? error.code : undefined;
	return { index, stage, message: readErrorMessage(error), ...(code !== undefined ? { code } : {}), committed, unknown };
}

/**
 * The rows a statement reported changing.
 *
 * @param result - The `execute` answer.
 * @returns The count, or null when the node reported none.
 */
function affectedOf(result: SqlExecuteResult | undefined): number | null {
	const value = result?.affected_rows;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Why a statement's row count does not match what it had to change.
 *
 * @param statement - The statement.
 * @param affected - The rows it reported changing.
 * @returns The sentence, or null when it matches (or nothing was expected).
 */
function expectMismatch(statement: SqlApplyStatement, affected: number | null): string | null {
	if (statement.expect === undefined || affected === statement.expect) return null;
	const want = `${statement.expect} row${statement.expect === 1 ? '' : 's'}`;
	if (affected === null) return `The database did not say how many rows the statement changed; it must change exactly ${want}.`;
	return `The statement changed ${affected} row${affected === 1 ? '' : 's'}; it must change exactly ${want}. The row may have changed or gone since it was read.`;
}

/**
 * The failure for a statement the apply's time budget left no room for.
 *
 * @param index - The statement not sent.
 * @param total - How many statements the apply holds.
 * @param committed - How many are saved for certain.
 * @returns The record.
 */
function outOfTime(index: number, total: number, committed: number): SqlApplyFailure {
	return {
		index,
		stage: 'statement',
		message: `Stopped before statement ${index + 1} of ${total}: an apply may take ${Math.round(APPLY_BUDGET_MS / 60_000)} minutes in all, and that time ran out.`,
		committed,
		unknown: false,
	};
}

// =============================================================================
// SESSION IMPLEMENTATION
// =============================================================================

/** SqlSession over the shared tool session. */
class SqlToolSession implements SqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: SqlEndpoint;

	/** The shared session (it reads the task token from the store's vault at call time). */
	private readonly session: IToolSession;

	/**
	 * @param session - The shared session for the endpoint.
	 * @param endpoint - The endpoint to bind to (the app's token-free description).
	 */
	constructor(session: IToolSession, endpoint: SqlEndpoint) {
		this.session = session;
		this.endpoint = endpoint;
	}

	/** @inheritdoc */
	async execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<SqlExecuteResult> {
		// Omit `params` entirely when there is nothing to bind: the node's
		// placeholder rewriting is skipped for an empty list, so an unbound
		// statement keeps travelling exactly as it did before.
		const params = opts?.params;
		const input = params && params.length > 0 ? { sql, params } : { sql };
		// Default NO retry: an unmarked statement may well be a write. The wait
		// is the node's published statement deadline plus a pad, or none. The
		// caller's ticket goes down with the call (port of 740b69c6d), so a
		// request it abandoned is never sent again by the session's retry.
		const generation = opts?.generation;
		return this.session.invoke<SqlExecuteResult>('execute', input, {
			idempotent: opts?.idempotent === true,
			timeoutMs: statementWaitMs(this.session.info()),
			...(generation === undefined ? {} : { generation }),
		});
	}

	/**
	 * Apply app-written statements (see {@link SqlSession.applyBatch}).
	 * Runs exactly what it is given: the list's gate and the dialect rule
	 * (ClickHouse sessions undo nothing, so it is asked with `atomic: false`)
	 * belong to the engine core, the only caller in this realm.
	 *
	 * @param statements - The statements, in order.
	 * @param opts - Apply options.
	 * @param opts.atomic - Open a transaction (falls back when the node has no `begin`).
	 * @returns What ran.
	 */
	async applyBatch(statements: SqlApplyStatement[], opts: { atomic: boolean }): Promise<SqlApplyResult> {
		if (!opts.atomic) return this.applyEach(statements);
		let sessionId: string;
		try {
			sessionId = await this.begin();
		} catch (error) {
			// A node older than the transaction tools: nothing was opened, so
			// each statement commits on its own (and the result says so). Any
			// other refusal of `begin` applied nothing, and is the caller's.
			if (!isUnknownTool(error)) throw error;
			return this.applyEach(statements);
		}
		return this.applyInTransaction(sessionId, statements);
	}

	/**
	 * Open a transaction session.
	 *
	 * @returns Its session id.
	 * @throws ExplorerToolError when the node refused, or answered without an id.
	 */
	private async begin(): Promise<string> {
		const result = await this.session.invoke<{ session_id?: unknown }>('begin', {});
		const id = result?.session_id;
		if (typeof id !== 'string' || id === '') {
			throw new ExplorerToolError({ kind: 'malformed', tool: 'begin', message: 'begin answered without a session id, so nothing was applied.' });
		}
		return id;
	}

	/**
	 * Send one statement of an apply, once.
	 *
	 * @param statement - The statement.
	 * @param sessionId - The transaction session, or null to commit it on its own.
	 * @param waitMs - How long to wait for it.
	 * @returns The node's answer.
	 */
	private sendOne(statement: SqlApplyStatement, sessionId: string | null, waitMs: number): Promise<SqlExecuteResult> {
		const params = statement.params;
		const input = {
			sql: statement.sql,
			...(params && params.length > 0 ? { params } : {}),
			...(sessionId !== null ? { session_id: sessionId } : {}),
		};
		return this.session.invoke<SqlExecuteResult>('execute', input, { idempotent: false, timeoutMs: waitMs });
	}

	/**
	 * How long the next statement may wait: the node's published statement
	 * deadline (plus pad) when there is one, never more than what is left of
	 * the apply's budget.
	 *
	 * @param deadline - When the budget runs out (epoch ms).
	 * @returns The wait, or null when the budget has (all but) run out.
	 */
	private waitWithin(deadline: number): number | null {
		const left = deadline - Date.now();
		if (left < MIN_STATEMENT_WAIT_MS) return null;
		return Math.min(statementWaitMs(this.session.info()) ?? left, left);
	}

	/**
	 * Roll a session back, best effort: a rollback that fails changes nothing
	 * the caller can act on (the node already closed the session after a
	 * refused commit; otherwise its idle reaper rolls it back).
	 *
	 * @param sessionId - The session.
	 */
	private async rollbackQuietly(sessionId: string): Promise<void> {
		try {
			await this.session.invoke('rollback', { session_id: sessionId });
		} catch {
			// See above: nothing to do, and never sent again.
		}
	}

	/**
	 * Every statement on one transaction session, then commit; roll back on
	 * the first failure or row-count mismatch.
	 *
	 * @param sessionId - The session `begin` opened.
	 * @param statements - The statements.
	 * @returns What ran.
	 */
	private async applyInTransaction(sessionId: string, statements: SqlApplyStatement[]): Promise<SqlApplyResult> {
		const results: SqlApplyResult['results'] = [];
		const deadline = Date.now() + APPLY_BUDGET_MS;
		// Nothing is committed on any of these paths: the rollback (or, when it
		// cannot get through, the node's idle reaper) undoes what ran.
		const stop = async (failure: SqlApplyFailure): Promise<SqlApplyResult> => {
			await this.rollbackQuietly(sessionId);
			return { transactional: true, results, failure };
		};
		for (const [index, statement] of statements.entries()) {
			const waitMs = this.waitWithin(deadline);
			if (waitMs === null) return stop(outOfTime(index, statements.length, 0));
			let result: SqlExecuteResult;
			try {
				result = await this.sendOne(statement, sessionId, waitMs);
			} catch (error) {
				return stop(failureOf(error, index, 'statement', 0, false));
			}
			const affected = affectedOf(result);
			results.push({ affected_rows: affected ?? 0 });
			const mismatch = expectMismatch(statement, affected);
			if (mismatch !== null) return stop({ index, stage: 'expect', message: mismatch, committed: 0, unknown: false });
		}
		try {
			await this.session.invoke('commit', { session_id: sessionId });
		} catch (error) {
			// A refused commit rolled the transaction back (PostgreSQL refuses to
			// commit an aborted one, and the node closes the session either way);
			// a commit whose answer never arrived may have gone through.
			return stop(failureOf(error, statements.length, 'commit', 0, !answeredNo(error)));
		}
		return { transactional: true, results, failure: null };
	}

	/**
	 * Every statement on its own (each commits as it runs), stopping at the
	 * first failure or row-count mismatch.
	 *
	 * @param statements - The statements.
	 * @returns What ran.
	 */
	private async applyEach(statements: SqlApplyStatement[]): Promise<SqlApplyResult> {
		const results: SqlApplyResult['results'] = [];
		const deadline = Date.now() + APPLY_BUDGET_MS;
		for (const [index, statement] of statements.entries()) {
			const waitMs = this.waitWithin(deadline);
			if (waitMs === null) return { transactional: false, results, failure: outOfTime(index, statements.length, index) };
			let result: SqlExecuteResult;
			try {
				result = await this.sendOne(statement, null, waitMs);
			} catch (error) {
				// The ones before it committed; it did not, unless its answer never arrived.
				return { transactional: false, results, failure: failureOf(error, index, 'statement', index, !answeredNo(error)) };
			}
			const affected = affectedOf(result);
			results.push({ affected_rows: affected ?? 0 });
			// It ran and committed: counted, and nothing after it is sent.
			const mismatch = expectMismatch(statement, affected);
			if (mismatch !== null) return { transactional: false, results, failure: { index, stage: 'expect', message: mismatch, committed: index + 1, unknown: false } };
		}
		return { transactional: false, results, failure: null };
	}

	/** @inheritdoc */
	async getSchema(table?: string): Promise<SqlSchemaResponse> {
		return this.session.invoke<SqlSchemaResponse>('get_schema', table ? { table } : {});
	}

	/** @inheritdoc */
	async refreshSchema(): Promise<SqlSchemaResponse> {
		try {
			return await this.session.invoke<SqlSchemaResponse>('refresh_schema', {});
		} catch (error) {
			// A dropped (superseded) result is not a failure of the tool.
			if (isStaleError(error)) throw error;
			// ANY other failure falls back. A node without the tool and a node
			// that simply could not answer are indistinguishable at this layer,
			// and matching the engine's error wording would rot the first time it
			// changed. Serve the task-start snapshot and flag it, rather than
			// present it as freshly reflected; when the fallback ALSO fails, its
			// error is the one the caller sees.
			const schema = await this.getSchema();
			return { ...schema, stale: true };
		}
	}

	/** @inheritdoc */
	async dialect(): Promise<SqlDialect> {
		const result = await this.session.invoke<{ dialect?: string }>('dialect', {});
		return toDialect(result?.dialect);
	}
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a live session bound to one database endpoint.
 *
 * @param session - The endpoint store's session for the endpoint (`store.session(client, endpoint)`).
 * @param endpoint - The app's token-free description of the endpoint.
 * @returns The bound session.
 */
export function createSqlSession(session: IToolSession, endpoint: SqlEndpoint): SqlSession {
	return new SqlToolSession(session, endpoint);
}

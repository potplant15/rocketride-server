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
// CONNECT SESSION — APPLY (the node's begin / execute{session_id} / commit)
// =============================================================================
//
// An Apply is the one place the app opens a transaction. The sequence is
// begin, then every statement on the session, each checked against the rows
// it must change, then commit. Anything that goes wrong after begin rolls
// back, and never commits. Nothing is ever sent twice. Where there is no
// transaction to have (a node without the tools), each statement commits on
// its own and the first failure stops the rest.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { SqlApplyStatement, SqlSession } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { APPLY_BUDGET_MS, BEGIN_WAIT_MS, END_TX_WAIT_MS } from '../src/connect/tools';
import { currentRows, describeEndpoint, registerEndpoint, resetEndpoints, sqlEndpoints } from './support';

/** The SDK is told to wait this much longer than the session (shared session.ts). */
const SDK_SLACK_MS = 1_000;

/** One recorded tool invocation. */
interface ICall {
	tool: string;
	input: Record<string, unknown>;
	timeout: number | undefined;
}

/**
 * A fake client: `tool` answers per call, every call recorded.
 *
 * @param behave - Answers one call (throw to fail it).
 * @returns The client and its log.
 */
function fakeClient(behave: (call: ICall) => unknown): { client: IExplorerClient; calls: ICall[] } {
	const calls: ICall[] = [];
	const client: IExplorerClient = {
		getTasks: async () => currentRows() as unknown as Array<Record<string, unknown>>,
		getTaskPipeline: async () => undefined,
		tool: async <T,>({ tool, input, timeout }: { tool: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> => {
			const call: ICall = { tool, input: input ?? {}, timeout };
			calls.push(call);
			return behave(call) as T;
		},
	};
	return { client, calls };
}

/**
 * A node with the transaction tools: `begin` opens `tx-1`, every statement
 * changes one row unless `rows` says otherwise.
 *
 * @param over - Answers to replace, by tool (or by statement text for execute).
 * @returns The behaviour.
 */
function node(over: { begin?: (call: ICall) => unknown; commit?: (call: ICall) => unknown; rollback?: (call: ICall) => unknown; execute?: (call: ICall) => unknown } = {}) {
	return (call: ICall): unknown => {
		switch (call.tool) {
			case 'begin': return over.begin ? over.begin(call) : { session_id: 'tx-1' };
			case 'commit': return over.commit ? over.commit(call) : { ok: true };
			case 'rollback': return over.rollback ? over.rollback(call) : { ok: true };
			case 'execute': return over.execute ? over.execute(call) : { rows: [], affected_rows: 1 };
			default: return { dialect: 'postgres' };
		}
	};
}

/**
 * An error the way the SDK raises a node failure.
 *
 * @param message - The node's message.
 * @param code - The server's code, if any.
 * @returns The error.
 */
function raised(message: string, code?: string): Error {
	return Object.assign(new Error(message), code === undefined ? {} : { code });
}

/** Three row edits, each bound and expected to change one row. */
const EDITS: SqlApplyStatement[] = [
	{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2', params: ['paid', 5], expect: 1 },
	{ sql: 'INSERT INTO "orders" ("customer_id") VALUES ($1)', params: [3], expect: 1 },
	{ sql: 'DELETE FROM "orders" WHERE "order_id" = $1', params: [14], expect: 1 },
];

let endpoint: IExplorerEndpoint;

/**
 * SQL Explorer's session on the registered endpoint.
 *
 * @param client - The fake client.
 * @returns The session.
 */
function sessionOn(client: IExplorerClient): SqlSession {
	return createSqlSession(sqlEndpoints.session(client, endpoint), describeEndpoint(endpoint));
}

/**
 * The tools a log called, in order.
 *
 * @param calls - The log.
 * @returns Tool names.
 */
const tools = (calls: ICall[]): string[] => calls.map((call) => call.tool);

beforeEach(async () => {
	resetEndpoints();
	endpoint = await registerEndpoint('apply-suite');
});

describe('apply in one transaction', () => {
	it('commits on success: begin, every statement on the session in order with its binds, then commit', async () => {
		const fake = fakeClient(node());
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.deepEqual(result, { transactional: true, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'commit']);
		assert.deepEqual(fake.calls.slice(1, 4).map((call) => call.input), EDITS.map((statement) => ({ sql: statement.sql, params: statement.params, session_id: 'tx-1' })));
		assert.deepEqual(fake.calls[4]!.input, { session_id: 'tx-1' });
	});

	it('a statement that fails rolls back: no commit, nothing after it sent, nothing retried, the error verbatim', async () => {
		// TASK_STOPPED is the one code a read may be retried on: a write in a
		// transaction never is.
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('INSERT')) throw raised('SQL execution failed: duplicate key value violates unique constraint "orders_pkey"', 'TASK_STOPPED');
			return { rows: [], affected_rows: 1 };
		} }));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'rollback']);
		assert.deepEqual(fake.calls[3]!.input, { session_id: 'tx-1' });
		assert.equal(result.transactional, true);
		assert.deepEqual(result.failure, {
			index: 1,
			stage: 'statement',
			message: 'SQL execution failed: duplicate key value violates unique constraint "orders_pkey"',
			code: 'TASK_STOPPED',
			committed: 0,
			unknown: false,
		});
	});

	it('a statement that changes another number of rows than expected rolls back, and nothing is committed', async () => {
		const fake = fakeClient(node({ execute: (call) => ({ rows: [], affected_rows: String(call.input.sql).startsWith('DELETE') ? 0 : 1 }) }));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'rollback']);
		assert.equal(result.failure?.stage, 'expect');
		assert.equal(result.failure?.index, 2);
		assert.equal(result.failure?.committed, 0);
		assert.equal(result.failure?.unknown, false);
		assert.match(result.failure?.message ?? '', /changed 0 rows; it must change exactly 1/);
		// Two rows is a mismatch too: the key matched more than one row.
		const two = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 2 }) }));
		const second = await sessionOn(two.client).applyStatements(EDITS.slice(0, 1), { atomic: true });
		assert.equal(second.failure?.stage, 'expect');
		assert.deepEqual(tools(two.calls), ['begin', 'execute', 'rollback']);
	});

	it('a refused commit is a failure: nothing is committed, the commit is not sent again, and the session is rolled back', async () => {
		const refusal = 'commit refused: an earlier statement failed and aborted this transaction. It has been rolled back and the session is closed; no changes were committed.';
		const fake = fakeClient(node({
			commit: () => { throw raised(refusal); },
			// The node closed the session when it refused the commit.
			rollback: () => { throw raised('unknown or expired transaction session: tx-1'); },
		}));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'commit', 'rollback']);
		assert.deepEqual(result.failure, { index: 3, stage: 'commit', message: refusal, committed: 0, unknown: false });
		assert.equal(result.transactional, true);
	});

	it('a commit whose answer never arrived may have committed: the result says the outcome is unknown', async () => {
		const fake = fakeClient(node({ commit: () => { throw new ExplorerToolError({ kind: 'timeout', tool: 'commit', message: 'Stopped waiting for commit after 60 s.' }); } }));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.equal(result.failure?.stage, 'commit');
		assert.equal(result.failure?.unknown, true);
		assert.equal(result.failure?.committed, 0);
	});

	it('a begin the node refuses applies nothing and is thrown (nothing else is sent, nothing retried)', async () => {
		const fake = fakeClient(node({ begin: () => { throw raised('execute tool is disabled for this node (set allow_execute=true)', 'TASK_STOPPED'); } }));
		await assert.rejects(sessionOn(fake.client).applyStatements(EDITS, { atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.tool === 'begin' && /allow_execute/.test(error.message));
		assert.deepEqual(tools(fake.calls), ['begin']);
	});

	it('a begin that answers without a session id applies nothing', async () => {
		const fake = fakeClient(node({ begin: () => ({ ok: true }) }));
		await assert.rejects(sessionOn(fake.client).applyStatements(EDITS, { atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'malformed');
		assert.deepEqual(tools(fake.calls), ['begin']);
	});

	it('names every wait: begin 40 s, commit and rollback 60 s, the statements at most 300 s in all', async () => {
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('DELETE')) throw raised('SQL execution failed: permission denied');
			return { rows: [], affected_rows: 1 };
		} }));
		await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		const timeout = (tool: string): Array<number | undefined> => fake.calls.filter((call) => call.tool === tool).map((call) => call.timeout);
		assert.equal(BEGIN_WAIT_MS, 40_000);
		assert.equal(END_TX_WAIT_MS, 60_000);
		assert.equal(APPLY_BUDGET_MS, 300_000);
		assert.deepEqual(timeout('begin'), [BEGIN_WAIT_MS + SDK_SLACK_MS]);
		assert.deepEqual(timeout('rollback'), [END_TX_WAIT_MS + SDK_SLACK_MS]);
		for (const wait of timeout('execute')) {
			assert.ok(typeof wait === 'number' && wait <= APPLY_BUDGET_MS + SDK_SLACK_MS && wait > APPLY_BUDGET_MS - 10_000, `a statement waits for what is left of the budget (${wait})`);
		}
	});
});

describe('apply without a transaction', () => {
	it('a node without the transaction tools runs each statement on its own, says so, and stops at the first failure', async () => {
		const fake = fakeClient(node({
			begin: () => { throw raised('No handler found for tool "begin" on node "db_1"'); },
			execute: (call) => {
				if (String(call.input.sql).startsWith('INSERT')) throw raised('SQL execution failed: null value in column "customer_id"');
				return { rows: [], affected_rows: 1 };
			},
		}));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute']);
		assert.equal(fake.calls.some((call) => 'session_id' in call.input), false, 'no statement rides a session');
		assert.deepEqual(result, {
			transactional: false,
			results: [{ affected_rows: 1 }],
			failure: { index: 1, stage: 'statement', message: 'SQL execution failed: null value in column "customer_id"', committed: 1, unknown: false },
		});
	});

	it('asked for no transaction (ClickHouse, a MySQL plan) it sends no begin, commit or rollback', async () => {
		const fake = fakeClient(node());
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute', 'execute', 'execute']);
		assert.deepEqual(result, { transactional: false, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null });
	});

	it('a statement that changed the wrong number of rows has committed already: the result counts it, and nothing after it is sent', async () => {
		const fake = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 0 }) }));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute']);
		assert.equal(result.failure?.stage, 'expect');
		assert.equal(result.failure?.committed, 1);
	});

	it('a statement whose answer never arrived may have committed: the earlier ones did, its own outcome is unknown', async () => {
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('INSERT')) throw new ExplorerToolError({ kind: 'timeout', tool: 'execute', message: 'Stopped waiting for execute after 300 s.' });
			return { rows: [], affected_rows: 1 };
		} }));
		const result = await sessionOn(fake.client).applyStatements(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute', 'execute']);
		assert.equal(result.failure?.committed, 1);
		assert.equal(result.failure?.unknown, true);
	});

	it('a statement without `expect` may change any number of rows (a DDL plan)', async () => {
		const fake = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 0 }) }));
		const result = await sessionOn(fake.client).applyStatements([{ sql: 'ALTER TABLE "orders" ADD COLUMN "notes" text' }], { atomic: true });
		assert.deepEqual(result, { transactional: true, results: [{ affected_rows: 0 }], failure: null });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'ALTER TABLE "orders" ADD COLUMN "notes" text', session_id: 'tx-1' }, 'no params key when there is nothing to bind');
	});
});

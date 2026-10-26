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
// DESIGNER APPLY — one transaction on PostgreSQL, the plan kept when it fails
// =============================================================================
//
// The designer's Apply goes through SqlSession.applyBatch: as one
// transaction on PostgreSQL (its DDL is transactional), statement by
// statement elsewhere (MySQL commits DDL implicitly; ClickHouse has no
// transactions). The pure helpers TableDesignView exports are tested here;
// the view itself has no DOM harness, so its wiring is checked in its source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AlterOp, ColumnSpec } from '../src/sql/ddl';
import { generateAlterStatements, generateCreateTable } from '../src/sql/ddl';
import { ALLOW_EXECUTE_OFF_TEXT } from '../src/sql/failure';
import { describeApplyFailure, describeApplySuccess, designApplyMode, planAfterFailure } from '../src/views/TableDesignView';
import type { DesignApplyFailure } from '../src/views/TableDesignView';

const VIEW = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'TableDesignView.tsx'), 'utf8');

const SPEC: ColumnSpec = { name: 'notes', type: 'text', nullable: true, defaultExpr: '', primaryKey: false };

/** One op of every kind the designer stages. */
const EVERY_OP: AlterOp[] = [
	{ kind: 'addColumn', spec: { ...SPEC, nullable: false, defaultExpr: "''" } },
	{ kind: 'dropColumn', name: 'legacy' },
	{ kind: 'renameColumn', name: 'qty', newName: 'quantity' },
	{ kind: 'changeType', name: 'quantity', type: 'bigint' },
	{ kind: 'addForeignKey', name: 'orders_customer_fk', column: 'customer_id', refTable: 'customers', refColumn: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
	{ kind: 'dropForeignKey', name: 'orders_old_fk' },
];

/**
 * A failure record over the common case.
 *
 * @param over - Fields to override.
 * @returns The record.
 */
function failure(over: Partial<DesignApplyFailure> = {}): DesignApplyFailure {
	return { stage: 'statement', failedAt: 1, committed: 0, total: 3, remaining: 3, message: 'SQL execution failed: column "quantity" does not exist', transactional: true, unknown: false, fellBack: false, ...over };
}

describe('designApplyMode: one transaction on PostgreSQL only', () => {
	it('PostgreSQL asks for one transaction, and its note does not promise one before the reply says so', () => {
		const mode = designApplyMode('postgres');
		assert.equal(mode.atomic, true);
		assert.match(mode.note ?? '', /^PostgreSQL: Apply sends the plan as one transaction, so a failure rolls back the whole plan\. The result says whether it ran as one\.$/);
	});

	it('MySQL and ClickHouse run statement by statement, with their notes unchanged', () => {
		assert.deepEqual(designApplyMode('mysql'), { atomic: false, note: 'MySQL: each DDL statement commits implicitly. A failure mid-plan leaves earlier statements applied. Nothing here can be rolled back.' });
		assert.deepEqual(designApplyMode('clickhouse'), { atomic: false, note: 'ClickHouse: some ALTER forms run as asynchronous mutations and may finish after this dialog closes.' });
	});

	it('an engine that did not report its type gets no transaction and no note', () => {
		assert.deepEqual(designApplyMode('unknown'), { atomic: false, note: null });
	});
});

describe('the designer\'s PostgreSQL DDL can all run inside one transaction', () => {
	it('no statement the designer generates is one PostgreSQL refuses inside a transaction block', () => {
		const NOT_IN_A_TRANSACTION = /\bCONCURRENTLY\b|\bADD\s+VALUE\b|\bVACUUM\b|\b(?:CREATE|DROP)\s+DATABASE\b|\b(?:CREATE|DROP)\s+TABLESPACE\b|\bALTER\s+SYSTEM\b|\bREINDEX\b|\bCLUSTER\b/i;
		const statements = [...generateAlterStatements('postgres', 'orders', EVERY_OP), generateCreateTable('postgres', 'notes', [{ ...SPEC, primaryKey: true }])];
		assert.equal(statements.length, EVERY_OP.length + 1);
		for (const sql of statements) assert.doesNotMatch(sql, NOT_IN_A_TRANSACTION, sql);
		for (const sql of statements) assert.match(sql, /^(?:ALTER TABLE|CREATE TABLE) /, 'only ALTER TABLE and CREATE TABLE');
	});
});

describe('the plan after a failed apply', () => {
	const ops = EVERY_OP.slice(0, 3);

	it('one transaction rolled back: the WHOLE plan stays, whichever statement failed (no prefix dropped)', () => {
		for (const failedAt of [0, 1, 2]) assert.deepEqual(planAfterFailure(ops, failure({ failedAt, committed: 0 })), ops);
		assert.deepEqual(planAfterFailure(ops, failure({ stage: 'commit', failedAt: 3, committed: 0 })), ops);
	});

	it('statement by statement: what committed drops out, the rest stays', () => {
		assert.deepEqual(planAfterFailure(ops, failure({ transactional: false, failedAt: 2, committed: 2 })), ops.slice(2));
		assert.deepEqual(planAfterFailure(ops, failure({ transactional: false, failedAt: 0, committed: 0 })), ops);
	});
});

describe('the outcome banner says the plan ran as one transaction only when the reply did', () => {
	it('a failure in one transaction: nothing was applied, and the whole plan stays', () => {
		const { text } = describeApplyFailure(failure());
		assert.equal(text, 'Statement 2 of 3 failed. Database reported: column "quantity" does not exist The plan runs as one transaction: a failure rolls back the whole plan, so nothing was applied. The plan still holds all 3 statements.');
	});

	it('a refused commit in one transaction', () => {
		const { text } = describeApplyFailure(failure({ stage: 'commit', failedAt: 3, message: 'commit refused: an earlier statement failed and aborted this transaction.' }));
		assert.match(text, /^The commit was refused\. Database reported: commit refused/);
		assert.match(text, /The plan runs as one transaction: a failure rolls back the whole plan, so nothing was applied\./);
	});

	it('a commit whose answer never arrived: may or may not be applied', () => {
		const { text } = describeApplyFailure(failure({ stage: 'commit', failedAt: 3, unknown: true, message: 'Stopped waiting for commit after 60 s.' }));
		assert.match(text, /^The commit's answer did not arrive, so the plan may or may not be applied\./);
		assert.match(text, /Check the table before you apply again\./);
		assert.doesNotMatch(text, /nothing was applied/);
	});

	it('statement by statement (MySQL, ClickHouse): the wording is unchanged', () => {
		const { text } = describeApplyFailure(failure({ transactional: false, failedAt: 2, committed: 2, remaining: 1, message: "Duplicate column name 'notes'" }));
		assert.equal(text, "Statements 1–2 of 3 ran and are committed; statement 3 failed. Database reported: Duplicate column name 'notes' The plan now holds the remaining 1 statement.");
		assert.doesNotMatch(text, /one transaction/);
		assert.equal(describeApplyFailure(failure({ transactional: false, failedAt: 0, committed: 0, remaining: 3 })).text, 'Statement 1 of 3 failed. Database reported: column "quantity" does not exist Statements 2–3 were not run. The plan now holds the remaining 3 statements.');
	});

	it('PostgreSQL on a node without the transaction tools says each statement committed on its own', () => {
		const { text } = describeApplyFailure(failure({ transactional: false, fellBack: true, failedAt: 1, committed: 1, remaining: 2 }));
		assert.match(text, /^This node has no transaction tools, so each statement committed on its own\. Statement 1 of 3 ran and is committed; statement 2 failed\./);
	});

	it('a statement whose answer never arrived may have run', () => {
		const { text } = describeApplyFailure(failure({ transactional: false, failedAt: 1, committed: 1, unknown: true, remaining: 2, message: 'Stopped waiting for execute after 300 s.' }));
		assert.match(text, /Statement 2 may have run too: its answer did not arrive\./);
	});

	it('nothing sent (the apply was refused): nothing was applied, and allow_execute is named when it is the reason', () => {
		const { text } = describeApplyFailure(failure({ stage: 'apply', failedAt: 0, message: 'execute tool is disabled for this node (set allow_execute=true)' }));
		assert.match(text, /^Nothing was applied\. /);
		assert.ok(text.includes(ALLOW_EXECUTE_OFF_TEXT));
		assert.doesNotMatch(text, /one transaction/);
	});

	it('success: "as one transaction" only when the reply said so', () => {
		const at = new Date(2026, 9, 23, 14, 39).getTime();
		assert.deepEqual(describeApplySuccess({ at, transactional: true, fellBack: false, reReadWorked: true }), { variant: 'info', text: 'Applied 14:39 as one transaction · schema re-read from the database.' });
		assert.deepEqual(describeApplySuccess({ at, transactional: false, fellBack: false, reReadWorked: true }), { variant: 'info', text: 'Applied 14:39 · schema re-read from the database.' });
		assert.match(describeApplySuccess({ at, transactional: false, fellBack: true, reReadWorked: true }).text, /each statement committed on its own/);
		assert.equal(describeApplySuccess({ at, transactional: false, fellBack: false, reReadWorked: false }).variant, 'warning');
	});
});

describe('TableDesignView applies through applyBatch', () => {
	it('sends the plan in one call, atomic by the dialect, and no longer runs statements one execute at a time', () => {
		assert.match(VIEW, /\.applyBatch\(statements\.map\(\(sql\) => \(\{ sql \}\)\), \{ atomic: mode\.atomic \}\)/);
		assert.match(VIEW, /const mode = designApplyMode\(snapshot\.dialect\)/);
		assert.doesNotMatch(VIEW, /for \(const sql of statements\)/);
		assert.doesNotMatch(VIEW, /prev\.slice\(done\)/);
		assert.match(VIEW, /setOps\(\(prev\) => planAfterFailure\(prev, \w+\)\)/);
	});
});

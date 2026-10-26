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
// SAFETY — when a statement asks first, and what DROP and TRUNCATE ask for
// =============================================================================
//
// The connection's safety level decides which statements ask before they are
// sent: `off` never, `risky` the shapes the pattern check flags, `every` any
// statement the classifier does not call a read (CALL, GRANT, SET and DO
// included: a procedure can change rows). At `risky` and `every`,
// DROP and TRUNCATE also ask for the target's name to be typed, exactly as
// the statement spells it. Everything here reads the statement TEXT; it
// prevents nothing the database would do on its own.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDialect } from '../src/connect';
import type { SafetyLevel } from '../src/connect/savedConnections';
import {
	confirmTextMatches,
	destructiveTarget,
	isWriteConfirmation,
	needsConfirmation,
	writeConfirmCopy,
} from '../src/sql/safety';
import type { WriteConfirmation } from '../src/sql/safety';

const LEVELS: SafetyLevel[] = ['off', 'risky', 'every'];

/** The kind `every` reports for a statement that is neither a write nor DDL, nor a read. */
const NOT_A_READ = 'a statement that is not a read';

/**
 * What each level does with one statement: null when it runs at once, the
 * finding's kind when it asks, with `+name` when a name must be typed.
 *
 * @param sql - The statement.
 * @param dialect - The dialect.
 * @returns One answer per level.
 */
function matrix(sql: string, dialect: SqlDialect = 'postgres'): Record<SafetyLevel, string | null> {
	const row = {} as Record<SafetyLevel, string | null>;
	for (const level of LEVELS) {
		const found = needsConfirmation(sql, dialect, level);
		row[level] = found === null ? null : `${found.kind}${found.target ? ' +name' : ''}`;
	}
	return row;
}

describe('needsConfirmation: the level × kind matrix', () => {
	const cases: Array<[string, string, Record<SafetyLevel, string | null>]> = [
		['read', 'SELECT * FROM orders', { off: null, risky: null, every: null }],
		['plain EXPLAIN of a write (plans only)', 'EXPLAIN DELETE FROM orders', { off: null, risky: null, every: null }],
		['bounded UPDATE', "UPDATE orders SET status = 'cancelled' WHERE sku = 'KB-101'", { off: null, risky: null, every: 'a write' }],
		['bounded DELETE', 'DELETE FROM orders WHERE id = 7', { off: null, risky: null, every: 'a write' }],
		['INSERT', 'INSERT INTO orders (id) VALUES (1)', { off: null, risky: null, every: 'a write' }],
		['SELECT … INTO', 'SELECT * INTO archive FROM orders', { off: null, risky: null, every: 'a write' }],
		['unbounded UPDATE', "UPDATE orders SET status = 'cancelled'", { off: null, risky: 'UPDATE without WHERE', every: 'UPDATE without WHERE' }],
		['unbounded DELETE', 'DELETE FROM orders', { off: null, risky: 'DELETE without WHERE', every: 'DELETE without WHERE' }],
		['DELETE inside a WITH clause', 'WITH gone AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM gone', { off: null, risky: 'DELETE inside a WITH clause', every: 'DELETE inside a WITH clause' }],
		['EXPLAIN ANALYZE runs its statement', 'EXPLAIN ANALYZE DELETE FROM orders', { off: null, risky: 'DELETE without WHERE', every: 'DELETE without WHERE' }],
		['CREATE', 'CREATE TABLE t (id int)', { off: null, risky: null, every: 'a schema change' }],
		['ALTER', 'ALTER TABLE orders ADD COLUMN note text', { off: null, risky: 'ALTER', every: 'ALTER' }],
		['DROP', 'DROP TABLE orders', { off: null, risky: 'DROP +name', every: 'DROP +name' }],
		['TRUNCATE', 'TRUNCATE orders', { off: null, risky: 'TRUNCATE +name', every: 'TRUNCATE +name' }],
		['other: CALL', 'CALL purge_orders()', { off: null, risky: null, every: NOT_A_READ }],
		['other: GRANT', 'GRANT SELECT ON orders TO reporting', { off: null, risky: null, every: NOT_A_READ }],
		['other: SET', 'SET search_path TO archive', { off: null, risky: null, every: NOT_A_READ }],
		['other: DO', "DO $$ BEGIN DELETE FROM orders; END $$", { off: null, risky: null, every: NOT_A_READ }],
		['other: VALUES (not a read to the classifier)', 'VALUES (1), (2)', { off: null, risky: null, every: NOT_A_READ }],
		['read: WITH … SELECT', 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent', { off: null, risky: null, every: null }],
		['read: SHOW', 'SHOW TABLES', { off: null, risky: null, every: null }],
		['read: DESCRIBE', 'DESCRIBE orders', { off: null, risky: null, every: null }],
		['transaction control (refused before this is asked)', 'BEGIN', { off: null, risky: null, every: null }],
		['empty', '  -- nothing\n', { off: null, risky: null, every: null }],
	];
	for (const [name, sql, expected] of cases) {
		it(name, () => {
			assert.deepEqual(matrix(sql), expected);
		});
	}

	it('a bounded UPDATE … WHERE asks at every and not at risky, on every dialect', () => {
		for (const dialect of ['postgres', 'mysql', 'clickhouse', 'unknown'] as SqlDialect[]) {
			const sql = "UPDATE orders SET status = 'shipped' WHERE order_id = 7";
			assert.equal(needsConfirmation(sql, dialect, 'risky'), null, dialect);
			assert.ok(needsConfirmation(sql, dialect, 'every'), dialect);
		}
	});

	it('carries the level that asked', () => {
		assert.equal(needsConfirmation('DELETE FROM orders', 'postgres', 'risky')?.level, 'risky');
		assert.equal(needsConfirmation('DELETE FROM orders', 'postgres', 'every')?.level, 'every');
	});

	it('is recognised as a write confirmation by the dialog, and a bare finding is not', () => {
		const found = needsConfirmation('DROP TABLE orders', 'postgres', 'risky');
		assert.ok(found && isWriteConfirmation(found));
		assert.equal(isWriteConfirmation({ kind: 'DROP' }), false);
	});
});

describe('destructiveTarget', () => {
	/**
	 * The parts of a target a test pins.
	 *
	 * @param sql - The statement.
	 * @param dialect - The dialect.
	 * @returns verb, object, names and the text to type, or null.
	 */
	const target = (sql: string, dialect: SqlDialect = 'postgres') => {
		const found = destructiveTarget(sql, dialect);
		return found && { verb: found.verb, object: found.object, names: found.names, confirmText: found.confirmText };
	};

	it('a table by its name', () => {
		assert.deepEqual(target('DROP TABLE orders;'), { verb: 'DROP', object: 'table', names: ['orders'], confirmText: 'orders' });
		assert.deepEqual(target('TRUNCATE orders'), { verb: 'TRUNCATE', object: 'table', names: ['orders'], confirmText: 'orders' });
		assert.deepEqual(target('truncate table orders'), { verb: 'TRUNCATE', object: 'table', names: ['orders'], confirmText: 'orders' });
	});

	it('the name as the statement spells it, case kept', () => {
		assert.equal(target('drop table if exists Orders')?.confirmText, 'Orders');
	});

	it('IF EXISTS, TEMPORARY, CONCURRENTLY, ONLY and trailing options are read past', () => {
		assert.equal(target('DROP TABLE IF EXISTS orders CASCADE')?.confirmText, 'orders');
		assert.equal(target('DROP TEMPORARY TABLE IF EXISTS tmp_orders', 'mysql')?.confirmText, 'tmp_orders');
		assert.equal(target('DROP INDEX CONCURRENTLY IF EXISTS orders_status_idx')?.confirmText, 'orders_status_idx');
		assert.equal(target('TRUNCATE TABLE ONLY orders RESTART IDENTITY CASCADE')?.confirmText, 'orders');
		assert.equal(target('TRUNCATE orders *')?.confirmText, 'orders');
	});

	it('a schema-qualified name is shown whole and confirmed by the object\'s own name', () => {
		assert.deepEqual(target('DROP TABLE public.orders'), { verb: 'DROP', object: 'table', names: ['public.orders'], confirmText: 'orders' });
		assert.equal(target('DROP TABLE IF EXISTS shop.events ON CLUSTER main SYNC', 'clickhouse')?.confirmText, 'events');
		assert.equal(target('TRUNCATE TABLE IF EXISTS shop.events', 'clickhouse')?.confirmText, 'events');
	});

	it('quoted names lose their quotes and keep what is inside, doubled quotes undone', () => {
		assert.deepEqual(target('DROP TABLE "public"."Order Items"'), { verb: 'DROP', object: 'table', names: ['public.Order Items'], confirmText: 'Order Items' });
		assert.equal(target('DROP TABLE "we""ird"')?.confirmText, 'we"ird');
		assert.equal(target('DROP TABLE `shop`.`order``s`', 'mysql')?.confirmText, 'order`s');
		assert.equal(target('DROP TABLE "a.b"')?.confirmText, 'a.b');
	});

	it('other kinds of object', () => {
		assert.deepEqual(target('DROP VIEW recent_orders'), { verb: 'DROP', object: 'view', names: ['recent_orders'], confirmText: 'recent_orders' });
		assert.equal(target('DROP MATERIALIZED VIEW mv_sales')?.object, 'materialized view');
		assert.equal(target('DROP DATABASE shop', 'mysql')?.confirmText, 'shop');
		assert.equal(target('DROP SCHEMA archive CASCADE')?.confirmText, 'archive');
		assert.equal(target('DROP INDEX orders_status_idx ON orders', 'mysql')?.confirmText, 'orders_status_idx');
		assert.equal(target('DROP DICTIONARY shop.rates', 'clickhouse')?.confirmText, 'rates');
	});

	it('several targets, or names it cannot read, are confirmed by typing the verb', () => {
		assert.deepEqual(target('DROP TABLE orders, order_items'), { verb: 'DROP', object: 'table', names: ['orders', 'order_items'], confirmText: 'DROP' });
		assert.deepEqual(target('TRUNCATE orders, order_items'), { verb: 'TRUNCATE', object: 'table', names: ['orders', 'order_items'], confirmText: 'TRUNCATE' });
		assert.deepEqual(target('DROP FUNCTION refresh_totals(int)'), { verb: 'DROP', object: 'function', names: [], confirmText: 'DROP' });
		assert.deepEqual(target('TRUNCATE ALL TABLES FROM shop', 'clickhouse'), { verb: 'TRUNCATE', object: 'table', names: [], confirmText: 'TRUNCATE' });
		assert.deepEqual(target('DROP TABLE'), { verb: 'DROP', object: 'table', names: [], confirmText: 'DROP' });
	});

	it('comments around the statement are read past with the dialect\'s rules', () => {
		assert.equal(target('/* careful */ DROP TABLE -- the old one\n orders')?.confirmText, 'orders');
		assert.equal(target('# old\nDROP TABLE orders', 'mysql')?.confirmText, 'orders');
	});

	it('is null for anything that is not a DROP or a TRUNCATE', () => {
		assert.equal(target('DELETE FROM orders'), null);
		assert.equal(target('ALTER TABLE orders DROP COLUMN note'), null);
		assert.equal(target("SELECT 'drop table orders'"), null);
		assert.equal(target('DROPPED'), null);
	});
});

describe('confirmTextMatches', () => {
	const one = destructiveTarget('DROP TABLE orders', 'postgres');
	const many = destructiveTarget('DROP TABLE orders, items', 'postgres');

	it('matches the exact text only: case-sensitive, nothing trimmed', () => {
		assert.ok(one && many);
		assert.equal(confirmTextMatches('orders', one), true);
		for (const typed of ['Orders', 'ORDERS', ' orders', 'orders ', 'order', 'public.orders', '']) assert.equal(confirmTextMatches(typed, one), false, JSON.stringify(typed));
		assert.equal(confirmTextMatches('DROP', many), true);
		assert.equal(confirmTextMatches('drop', many), false);
	});
});

describe('writeConfirmCopy', () => {
	/**
	 * The copy for a statement at a level.
	 *
	 * @param sql - The statement.
	 * @param level - The level.
	 * @returns The copy.
	 */
	const copyFor = (sql: string, level: SafetyLevel = 'risky') => {
		const found = needsConfirmation(sql, 'postgres', level) as WriteConfirmation;
		return writeConfirmCopy(found, sql, 'postgres', 'Shop Postgres');
	};

	it('DROP names the object and the action, and asks for the name', () => {
		const copy = copyFor('DROP TABLE orders');
		assert.equal(copy.title, 'Drop table orders?');
		assert.equal(copy.confirmLabel, 'Drop table');
		assert.match(copy.consequence, /cannot be undone/);
	});

	it('TRUNCATE says every row goes', () => {
		const copy = copyFor('TRUNCATE orders');
		assert.equal(copy.title, 'Empty table orders?');
		assert.equal(copy.confirmLabel, 'Empty table');
		assert.match(copy.consequence, /every row in orders/);
	});

	it('an unbounded write says it changes every row, and the button names the verb', () => {
		const copy = copyFor("UPDATE orders SET status = 'cancelled'");
		assert.equal(copy.title, 'Run this UPDATE?');
		assert.match(copy.consequence, /No WHERE clause: this changes every row/);
		assert.equal(copy.confirmLabel, 'Run UPDATE');
	});

	it('says why it asked: the connection\'s level, and that it is a text check', () => {
		assert.equal(copyFor('DELETE FROM orders').why, 'Shop Postgres is set to ask before risky writes. This is a check on the statement text, not a database permission.');
		assert.equal(copyFor('DELETE FROM orders WHERE id = 1', 'every').why, 'Shop Postgres is set to ask before every write. This is a check on the statement text, not a database permission.');
	});

	it('a statement that is not a read says it may change data, and the button names its verb', () => {
		const copy = copyFor('CALL purge_orders()', 'every');
		assert.equal(copy.title, 'Run this CALL?');
		assert.equal(copy.consequence, 'It is not a read, so it may change data.');
		assert.equal(copy.confirmLabel, 'Run CALL');
	});

	it('never offers to stop asking', () => {
		for (const sql of ['DROP TABLE orders', 'DELETE FROM orders', 'ALTER TABLE t ADD c int']) {
			assert.doesNotMatch(JSON.stringify(copyFor(sql)), /stop asking/i);
		}
	});
});

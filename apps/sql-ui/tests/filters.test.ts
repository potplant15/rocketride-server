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
// FILTERS — unit tests for chip predicates and case-insensitive text match
// =============================================================================
//
// Every user value is DATA: it rides as a bound `$n`, and the NULL operators
// bind nothing. The LIKE forms differ per engine (see NODE-FACTS §8), and the
// wildcard characters a user types are escaped inside the bound value.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDialect } from '../src/connect';
import { quoteIdent } from '../src/sql/paging';
import {
	FILTER_OPS,
	chipPredicate,
	describeChip,
	escapeLike,
	isCompleteChip,
	likePredicate,
	type FilterChip,
} from '../src/sql/filters';

/**
 * Render one chip the way the page builder does: collect binds in order.
 *
 * @param dialect - The engine dialect.
 * @param chip - The chip.
 * @returns The predicate and its bind values.
 */
function render(dialect: SqlDialect, chip: FilterChip): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	const bind = (value: unknown): string => {
		params.push(value);
		return `$${params.length}`;
	};
	return { sql: chipPredicate(dialect, quoteIdent(dialect, chip.column), chip, bind), params };
}

describe('escapeLike', () => {
	it('escapes backslash, percent and underscore', () => {
		assert.equal(escapeLike('50%_off\\now'), '50\\%\\_off\\\\now');
	});

	it('leaves other text alone', () => {
		assert.equal(escapeLike("o'brien"), "o'brien");
	});
});

describe('likePredicate', () => {
	it('uses ::text ILIKE on Postgres', () => {
		assert.equal(likePredicate('postgres', '"c"', '$1'), '"c"::text ILIKE $1');
	});

	it('uses LOWER() LIKE LOWER() on MySQL', () => {
		assert.equal(likePredicate('mysql', '`c`', '$1'), 'LOWER(`c`) LIKE LOWER($1)');
	});

	it('uses toString() ILIKE on ClickHouse', () => {
		assert.equal(likePredicate('clickhouse', '`c`', '$1'), 'toString(`c`) ILIKE $1');
	});

	it('keeps plain LIKE on an unknown dialect', () => {
		assert.equal(likePredicate('unknown', '"c"', '$1'), '"c" LIKE $1');
	});
});

describe('chipPredicate', () => {
	const dialects: SqlDialect[] = ['postgres', 'mysql', 'clickhouse', 'unknown'];

	it('lists every operator the chips offer', () => {
		assert.deepEqual(
			FILTER_OPS.map((o) => o.op),
			['eq', 'ne', 'contains', 'startsWith', 'gt', 'lt', 'gte', 'lte', 'isNull', 'notNull'],
		);
	});

	for (const dialect of dialects) {
		const q = (name: string): string => quoteIdent(dialect, name);

		describe(dialect, () => {
			const cases: [FilterChip['op'], string][] = [
				['eq', '='],
				['ne', '<>'],
				['gt', '>'],
				['lt', '<'],
				['gte', '>='],
				['lte', '<='],
			];
			for (const [op, sym] of cases) {
				it(`${op} binds the value with ${sym}`, () => {
					const { sql, params } = render(dialect, { column: 'we"ird`col', op, value: '5' });
					assert.equal(sql, `${q('we"ird`col')} ${sym} $1`);
					assert.deepEqual(params, ['5']);
				});
			}

			it('contains wraps and escapes the bound value, case-insensitively', () => {
				const { sql, params } = render(dialect, { column: 'note', op: 'contains', value: '50%_' });
				assert.equal(sql, likePredicate(dialect, q('note'), '$1'));
				assert.deepEqual(params, ['%50\\%\\_%']);
			});

			it('startsWith anchors only the end of the pattern', () => {
				const { sql, params } = render(dialect, { column: 'note', op: 'startsWith', value: 'a_b' });
				assert.equal(sql, likePredicate(dialect, q('note'), '$1'));
				assert.deepEqual(params, ['a\\_b%']);
			});

			it('isNull and notNull bind nothing', () => {
				const a = render(dialect, { column: 'note', op: 'isNull' });
				assert.equal(a.sql, `${q('note')} IS NULL`);
				assert.deepEqual(a.params, []);
				const b = render(dialect, { column: 'note', op: 'notNull', value: 'ignored' });
				assert.equal(b.sql, `${q('note')} IS NOT NULL`);
				assert.deepEqual(b.params, []);
			});
		});
	}
});

describe('chip helpers', () => {
	it('a value operator needs a value; a NULL operator does not', () => {
		assert.equal(isCompleteChip({ column: 'a', op: 'eq' }), false);
		assert.equal(isCompleteChip({ column: 'a', op: 'eq', value: '' }), true);
		assert.equal(isCompleteChip({ column: 'a', op: 'isNull' }), true);
		assert.equal(isCompleteChip({ column: '', op: 'isNull' }), false);
	});

	it('describes a chip in plain words', () => {
		assert.equal(describeChip({ column: 'total', op: 'gt', value: '100' }), 'total > 100');
		assert.equal(describeChip({ column: 'note', op: 'contains', value: 'x' }), 'note contains x');
		assert.equal(describeChip({ column: 'note', op: 'isNull' }), 'note is null');
	});
});

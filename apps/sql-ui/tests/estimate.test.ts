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
// ESTIMATE — unit tests for row estimates and the count planner
// =============================================================================
//
// The planner is pure: it says which statements a page request needs, given
// what is already known about the table and the filter. These tests pin that
// paging the same filter sends no second COUNT, that a big unfiltered table
// uses the catalog estimate, that a big filtered one is not counted, and that
// a schema-only node is sent nothing.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	ESTIMATE_THRESHOLD,
	applyEstimate,
	applyTotal,
	emptyCountCache,
	estimateStatement,
	overfetchPage,
	parseEstimate,
	planCount,
	type CountCache,
	type CountRequest,
} from '../src/sql/estimate';

/**
 * A count request with the given overrides over an unfiltered default.
 *
 * @param over - Fields to override.
 * @returns The request.
 */
function request(over: Partial<CountRequest> = {}): CountRequest {
	return { key: 'k', filtered: false, executeAllowed: true, forceExact: false, canProbe: true, ...over };
}

describe('estimateStatement', () => {
	it('reads pg_class on Postgres, binding the table name', () => {
		const stmt = estimateStatement('postgres', 'orders');
		assert.ok(stmt);
		assert.match(stmt.sql, /FROM pg_class c JOIN pg_namespace n/);
		assert.match(stmt.sql, /reltuples::bigint AS estimate/);
		assert.match(stmt.sql, /n\.nspname = current_schema\(\)/);
		assert.match(stmt.sql, /c\.relname = \$1/);
		assert.deepEqual(stmt.params, ['orders']);
	});

	it('reads information_schema.TABLES on MySQL', () => {
		const stmt = estimateStatement('mysql', 'orders');
		assert.ok(stmt);
		assert.match(stmt.sql, /TABLE_ROWS AS estimate FROM information_schema\.TABLES/);
		assert.match(stmt.sql, /TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \$1/);
		assert.deepEqual(stmt.params, ['orders']);
	});

	it('reads system.tables on ClickHouse', () => {
		const stmt = estimateStatement('clickhouse', 'orders');
		assert.ok(stmt);
		assert.match(stmt.sql, /total_rows AS estimate FROM system\.tables/);
		assert.match(stmt.sql, /database = currentDatabase\(\) AND name = \$1/);
		assert.deepEqual(stmt.params, ['orders']);
	});

	it('has no statement for an engine without a known catalog', () => {
		assert.equal(estimateStatement('unknown', 'orders'), null);
		assert.equal(estimateStatement('neo4j', 'orders'), null);
	});
});

describe('parseEstimate', () => {
	it('reads the estimate column of the first row', () => {
		assert.equal(parseEstimate([{ estimate: 250000 }]), 250000);
	});

	it('reads a number that arrived as a string (bigint, UInt64)', () => {
		assert.equal(parseEstimate([{ estimate: '1200000' }]), 1200000);
	});

	it('returns null for -1 (a Postgres table that was never analyzed)', () => {
		assert.equal(parseEstimate([{ estimate: -1 }]), null);
	});

	it('returns null for NULL, a missing row, or junk', () => {
		assert.equal(parseEstimate([{ estimate: null }]), null);
		assert.equal(parseEstimate([]), null);
		assert.equal(parseEstimate([{ estimate: 'many' }]), null);
		assert.equal(parseEstimate([{}]), null);
	});

	it('keeps zero, which is below the threshold', () => {
		assert.equal(parseEstimate([{ estimate: 0 }]), 0);
	});
});

describe('planCount', () => {
	const fresh = emptyCountCache('orders');

	it('probes the catalog first when nothing is known about the table', () => {
		assert.equal(planCount(fresh, request()), 'probe');
	});

	it('counts exactly when the table cannot be probed', () => {
		assert.equal(planCount(fresh, request({ canProbe: false })), 'count');
	});

	it('uses the estimate for an unfiltered table at or above the threshold', () => {
		assert.equal(planCount(applyEstimate(fresh, ESTIMATE_THRESHOLD), request()), 'estimate');
		assert.equal(planCount(applyEstimate(fresh, 5_000_000), request()), 'estimate');
	});

	it('counts exactly below the threshold', () => {
		assert.equal(planCount(applyEstimate(fresh, ESTIMATE_THRESHOLD - 1), request()), 'count');
	});

	it('falls back to an exact count when the estimate is unavailable (-1 or NULL)', () => {
		assert.equal(planCount(applyEstimate(fresh, null), request()), 'count');
	});

	it('pages a filtered big table by size + 1 instead of counting it', () => {
		assert.equal(planCount(applyEstimate(fresh, 5_000_000), request({ filtered: true })), 'overfetch');
	});

	it('counts a filtered small table', () => {
		assert.equal(planCount(applyEstimate(fresh, 500), request({ filtered: true })), 'count');
	});

	it('runs no second COUNT for another page of the same filter', () => {
		const counted = applyTotal(applyEstimate(fresh, 500), 'k', 42, true);
		assert.equal(planCount(counted, request({ filtered: true })), 'reuse');
	});

	it('recounts when the filter changes', () => {
		const counted = applyTotal(applyEstimate(fresh, 500), 'k', 42, true);
		assert.equal(planCount(counted, request({ key: 'other', filtered: true })), 'count');
	});

	it('does not probe again once the table is known, even for a new filter', () => {
		const known = applyEstimate(fresh, 500);
		assert.notEqual(planCount(known, request({ key: 'other' })), 'probe');
	});

	it('reuses a shown estimate while the filter is unchanged', () => {
		const shown = applyTotal(applyEstimate(fresh, 5_000_000), 'k', 5_000_000, false);
		assert.equal(planCount(shown, request()), 'reuse');
	});

	it('counts exactly on request, then reuses the exact total', () => {
		const shown = applyTotal(applyEstimate(fresh, 5_000_000), 'k', 5_000_000, false);
		assert.equal(planCount(shown, request({ forceExact: true })), 'count');
		const exact = applyTotal(shown, 'k', 4_999_871, true);
		assert.equal(planCount(exact, request({ forceExact: true })), 'reuse');
	});

	it('counts exactly on request for a filtered big table', () => {
		assert.equal(planCount(applyEstimate(fresh, 5_000_000), request({ filtered: true, forceExact: true })), 'count');
	});

	it('sends nothing on a schema-only node', () => {
		const cases: CountCache[] = [fresh, applyEstimate(fresh, 5_000_000), applyEstimate(fresh, 10)];
		for (const cache of cases) {
			for (const filtered of [false, true]) {
				assert.equal(planCount(cache, request({ filtered, executeAllowed: false })), 'none');
				assert.equal(planCount(cache, request({ filtered, executeAllowed: false, forceExact: true })), 'none');
			}
		}
	});
});

describe('overfetchPage', () => {
	const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

	it('trims the extra row and reports a next page', () => {
		const page = overfetchPage(rows(26), 2, 25);
		assert.equal(page.rows.length, 25);
		assert.equal(page.hasMore, true);
		assert.equal(page.total, 51);
	});

	it('reports the true total on the last page', () => {
		const page = overfetchPage(rows(7), 3, 25);
		assert.equal(page.rows.length, 7);
		assert.equal(page.hasMore, false);
		assert.equal(page.total, 57);
	});
});

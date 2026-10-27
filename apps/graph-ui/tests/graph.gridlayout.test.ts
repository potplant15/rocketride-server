// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GRID LAYOUTS: WHAT A SAVED RESULTS LAYOUT MAY RESTORE
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IDataGridPersistence } from 'shell';
import { MIN_SAVED_WIDTH, guardLayouts, layoutRulesFor, sanitizeColumnLayout } from '../src/graph/gridLayout';

/** The result grid's columns: generated keys, no width (all flexible). */
const RESULT = [{ field: 'c0' }, { field: 'c1' }, { field: 'c2' }];

/** What a grid built in a hidden tab saved. */
const CRUSHED = [{ field: 'c0', width: 40, visible: true }, { field: 'c1', width: 40, visible: true }, { field: 'c2', width: 40, visible: false }];

/** A persistence over a map, recording writes. */
function memory(seed: Record<string, unknown> = {}): { grids: IDataGridPersistence; store: Map<string, unknown>; cleared: string[] } {
	const store = new Map(Object.entries(seed));
	const cleared: string[] = [];
	return {
		store,
		cleared,
		grids: {
			read: (tableId, type) => store.get(`${tableId}/${type}`) ?? false,
			write: (tableId, type, data) => { store.set(`${tableId}/${type}`, data); },
			clear: (tableId) => { cleared.push(tableId); },
		},
	};
}

test('result columns all flex, so no width is kept for any of them', () => {
	const rules = layoutRulesFor(RESULT);
	assert.deepEqual(rules, { fixedWidths: [], alwaysVisible: [] });
	assert.deepEqual(sanitizeColumnLayout(CRUSHED, rules), [{ field: 'c0', visible: true }, { field: 'c1', visible: true }, { field: 'c2', visible: false }]);
});

test('a width under the minimum is dropped for a column the code sizes, a wider one is kept', () => {
	assert.equal(MIN_SAVED_WIDTH, 60);
	const rules = layoutRulesFor([{ field: 'a', width: 100 }, { field: 'b', width: 100 }]);
	assert.deepEqual(sanitizeColumnLayout([{ field: 'a', width: 12 }, { field: 'b', width: 300 }], rules), [{ field: 'a' }, { field: 'b', width: 300 }]);
});

test('anything that is not a column list is left alone', () => {
	assert.equal(sanitizeColumnLayout(false, layoutRulesFor(RESULT)), false);
	assert.deepEqual(sanitizeColumnLayout({ x: 1 }, layoutRulesFor(RESULT)), { x: 1 });
});

test('the guard heals a crushed layout as it is read, and never writes one back; other kinds pass through', () => {
	const { grids, store } = memory({ 'graph-results-t/columns': CRUSHED, 'graph-results-t/sort': [{ column: 'c0', dir: 'asc' }] });
	const guarded = guardLayouts(grids, layoutRulesFor(RESULT));
	assert.deepEqual(guarded.read('graph-results-t', 'columns'), [{ field: 'c0', visible: true }, { field: 'c1', visible: true }, { field: 'c2', visible: false }]);
	assert.deepEqual(store.get('graph-results-t/columns'), CRUSHED, 'reading did not write the healed copy back');
	assert.deepEqual(guarded.read('graph-results-t', 'sort'), [{ column: 'c0', dir: 'asc' }]);
	guarded.write('graph-results-t', 'columns', [{ field: 'c0', width: 40, visible: true }]);
	assert.deepEqual(store.get('graph-results-t/columns'), [{ field: 'c0', visible: true }], 'a crushed width is never saved');
	guarded.clear('graph-results-t');
});

test('the results grid goes through the guard', () => {
	const views = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ResultViews.tsx'), 'utf8');
	assert.match(views, /guardLayouts\(env\.gridPersistence, layoutRulesFor\(columns\)\)/);
	assert.match(views, /persistence=\{persistence\}/);
});

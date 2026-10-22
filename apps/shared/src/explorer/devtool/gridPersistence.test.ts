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
// EXPLORER DEV TOOL — GRID LAYOUTS IN A DEV-TOOL MOUNT (session only)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IDataGridPersistence } from 'shell';
import { createSessionGridPersistence } from './gridPersistence';

/** What Tabulator's sort module does to a persisted sorter list it is handed: it swaps each field for its live column. */
function tabulatorSetSort(sorters: unknown): void {
	const column = { field: 'name', table: {} as Record<string, unknown>, element: { tag: 'div' } };
	column.table.columns = [column];
	for (const item of sorters as Array<{ column: unknown }>) item.column = column;
}

describe('createSessionGridPersistence', () => {
	it('satisfies the shell DataGrid persistence contract', () => {
		const check = (p: IDataGridPersistence): IDataGridPersistence => p;
		assert.equal(typeof check(createSessionGridPersistence()).read, 'function');
	});

	it('reads report nothing until a layout is written; writes are read back', () => {
		const p = createSessionGridPersistence();
		assert.equal(p.read('t', 'sort'), false);
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }]);
		assert.equal(p.read('t', 'columns'), false, 'per type');
		assert.equal(p.read('other', 'sort'), false, 'per table');
	});

	it('hands out copies: Tabulator rewriting what it read in place never reaches the stored layout (the Rocket Builder freeze)', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		const handed = p.read('t', 'sort');
		tabulatorSetSort(handed);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }], 'the stored blob is still plain JSON');
		const blob = [{ column: 'name', dir: 'desc' }];
		p.write('t', 'sort', blob);
		tabulatorSetSort(blob);
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'desc' }], 'what was written was copied, too');
	});

	it('a blob that is not plain JSON is not stored (the previous one stays), and never throws', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		assert.doesNotThrow(() => p.write('t', 'sort', [cyclic]));
		assert.deepEqual(p.read('t', 'sort'), [{ column: 'name', dir: 'asc' }]);
		assert.doesNotThrow(() => p.write('t', 'format', { fn: () => 1 }));
		assert.deepEqual(p.read('t', 'format'), {}, 'a function is dropped, as JSON drops it');
	});

	it('clear forgets one table', () => {
		const p = createSessionGridPersistence();
		p.write('t', 'sort', [{ column: 'name', dir: 'asc' }]);
		p.write('u', 'sort', [{ column: 'id', dir: 'asc' }]);
		p.clear('t');
		assert.equal(p.read('t', 'sort'), false);
		assert.deepEqual(p.read('u', 'sort'), [{ column: 'id', dir: 'asc' }]);
	});
});

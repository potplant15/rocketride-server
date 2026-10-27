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
// RECORD DRAWER — unit tests for the pure model behind the data browser's row drawer
// =============================================================================
//
// Fields follow the schema's column order and never the row object's keys:
// the grid writes an undefined key into every row object for each column it
// renders (Tabulator `Cell.build`), so a row's own keys are not a column list.
// A foreign-key link looks the referenced row up with bound values.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlSchemaResponse } from '../src/connect';
import { buildRelationGraph } from '../src/schema/relations';
import {
	childRowsPreset,
	fallbackDef,
	recordFields,
	recordJson,
	referencedRowStatement,
	referencingEdges,
} from '../src/sql/record';

const SCHEMA: SqlSchemaResponse = {
	tables: {
		customers: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'name', type: 'VARCHAR(80)' }],
			primary_key: ['id'],
		},
		orders: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'customer_id', type: 'BIGINT' },
				{ column: 'total', type: 'NUMERIC(10,2)' },
			],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		shipments: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'order_no', type: 'INT' }, { column: 'carrier', type: 'TEXT' }],
			foreign_keys: [{ columns: ['tenant_id', 'order_no'], referred_table: 'order_lines', referred_columns: ['tenant_id', 'no'] }],
		},
		order_lines: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'no', type: 'INT' }],
			primary_key: ['tenant_id', 'no'],
		},
	},
};
const GRAPH = buildRelationGraph(SCHEMA);
const ORDERS = SCHEMA.tables!.orders!;

describe('recordFields', () => {
	it('follows the schema column order, not the row object order', () => {
		const row = { total: 9.5, id: 1, customer_id: 4 };
		assert.deepEqual(recordFields(ORDERS, row).map((f) => f.column), ['id', 'customer_id', 'total']);
	});

	it('does not derive the fields from the keys of the row', () => {
		// The grid adds an undefined key per rendered column to the row object.
		const row: Record<string, unknown> = { id: 1, customer_id: 4, total: 9.5, extra_from_grid: undefined };
		const fields = recordFields(ORDERS, row);
		assert.equal(fields.length, 3);
		assert.ok(!fields.some((f) => f.column === 'extra_from_grid'));
	});

	it('reads a column the row lacks as undefined and keeps its slot', () => {
		const fields = recordFields(ORDERS, { id: 1 });
		assert.equal(fields.length, 3);
		assert.equal(fields[2]!.value, undefined);
	});

	it('carries the type, the PK flag and the foreign keys of each column', () => {
		const [id, customer, total] = recordFields(ORDERS, { id: 1, customer_id: 4, total: 2 }, GRAPH, 'orders');
		assert.equal(id!.pk, true);
		assert.equal(id!.type, 'BIGINT');
		assert.equal(customer!.links.length, 1);
		assert.equal(customer!.links[0]!.refTable, 'customers');
		assert.equal(total!.links.length, 0);
	});
});

describe('recordJson', () => {
	it('writes the keys in schema order and leaves out keys the schema lacks', () => {
		const json = recordJson(ORDERS, { total: 2, extra: 'x', id: 1, customer_id: null });
		assert.deepEqual(Object.keys(JSON.parse(json) as object), ['id', 'customer_id', 'total']);
		assert.ok(!json.includes('extra'));
	});
});

describe('referencedRowStatement', () => {
	const edge = GRAPH.edges.find((e) => e.table === 'orders')!;

	it('looks the row up with a bound value, per dialect quoting', () => {
		const row = { id: 7, customer_id: 4, total: 1 };
		assert.deepEqual(referencedRowStatement('postgres', edge, row), {
			sql: 'SELECT * FROM "customers" WHERE "id" = $1 LIMIT 2',
			params: [4],
		});
		assert.deepEqual(referencedRowStatement('mysql', edge, row), {
			sql: 'SELECT * FROM `customers` WHERE `id` = $1 LIMIT 2',
			params: [4],
		});
	});

	it('handles a composite key: every column pair, in key order', () => {
		const composite = GRAPH.edges.find((e) => e.table === 'shipments')!;
		const stmt = referencedRowStatement('postgres', composite, { carrier: 'x', order_no: 12, tenant_id: 3 });
		assert.deepEqual(stmt, {
			sql: 'SELECT * FROM "order_lines" WHERE "tenant_id" = $1 AND "no" = $2 LIMIT 2',
			params: [3, 12],
		});
	});

	it('has no lookup when any key value is NULL (it points at nothing)', () => {
		assert.equal(referencedRowStatement('postgres', edge, { customer_id: null }), null);
		const composite = GRAPH.edges.find((e) => e.table === 'shipments')!;
		assert.equal(referencedRowStatement('postgres', composite, { tenant_id: 3, order_no: null }), null);
		assert.equal(referencedRowStatement('postgres', composite, { tenant_id: 3 }), null);
	});

	it('quotes hostile identifiers and binds hostile values', () => {
		const hostile = { id: 0, table: 'a"b', columns: ['c"d'], refTable: 'e"f', refColumns: ['g"h'] };
		const stmt = referencedRowStatement('postgres', hostile, { 'c"d': "1' OR '1'='1" });
		assert.deepEqual(stmt, { sql: 'SELECT * FROM "e""f" WHERE "g""h" = $1 LIMIT 2', params: ["1' OR '1'='1"] });
	});
});

describe('rows that reference this one', () => {
	it('lists the child tables whose keys point at the table', () => {
		const inbound = referencingEdges(GRAPH, 'customers');
		assert.deepEqual(inbound.map((e) => e.table), ['orders']);
		assert.deepEqual(referencingEdges(GRAPH, 'orders'), []);
	});

	it('presets one equals chip per key column for "Show rows"', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'orders')!;
		assert.deepEqual(childRowsPreset(edge, { id: 4, name: 'Ada' }), [{ column: 'customer_id', op: 'eq', value: '4' }]);
	});

	it('presets a chip for each column of a composite key', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'shipments')!;
		assert.deepEqual(childRowsPreset(edge, { tenant_id: 3, no: 12 }), [
			{ column: 'tenant_id', op: 'eq', value: '3' },
			{ column: 'order_no', op: 'eq', value: '12' },
		]);
	});

	it('presets nothing when a key value is NULL', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'orders')!;
		assert.equal(childRowsPreset(edge, { id: null }), null);
	});
});

describe('fallbackDef', () => {
	it('lists the columns of a freshly looked-up row when the schema has no entry for its table', () => {
		const def = fallbackDef({ id: 4, name: 'Ada' });
		assert.deepEqual(def.columns.map((c) => c.column), ['id', 'name']);
		assert.deepEqual(recordFields(def, { id: 4, name: 'Ada' }).map((f) => f.value), [4, 'Ada']);
	});
});

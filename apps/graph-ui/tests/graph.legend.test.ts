// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LEGEND: labels and relationship types with counts, label selection, distinct
// colours for a connection's labels, and the colours offered for types
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHART_COLOR_VARS, TYPE_COLOR_SLOTS, labelColors, typeColorsOf } from '../src/graph/colors';
import { legendOf, nodeIdsOfLabel, typeLegendOf } from '../src/graph/legend';
import { modelFromResult } from '../src/graph/model';
import { EMPTY_STYLE } from '../src/graph/userData';
import { entitiesOf, node, rel } from './support/builders';

const model = modelFromResult(
	entitiesOf(
		[node('1', ['Person']), node('2', ['Person']), node('3', ['Company']), node('4', [])],
		[rel('r1', 'WORKS_AT', '1', '3'), rel('r2', 'WORKS_AT', '2', '3'), rel('r3', 'KNOWS', '1', '2')]
	)
);

test('the legend counts drawn nodes under their first label, most first', () => {
	const colors = labelColors(EMPTY_STYLE, ['Person', 'Company']);
	assert.deepEqual(legendOf(model, colors).map((e) => [e.name, e.count]), [['Person', 2], ['(no label)', 1], ['Company', 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] < b[0] ? -1 : 1)));
});

test('the type legend counts drawn relationships per type and carries the colour a style gave the type', () => {
	const colors = typeColorsOf({ ...EMPTY_STYLE, types: { KNOWS: { slot: 4 } } });
	assert.deepEqual(typeLegendOf(model, colors), [
		{ type: 'WORKS_AT', count: 2, fill: null },
		{ type: 'KNOWS', count: 1, fill: `var(${CHART_COLOR_VARS[4]})` },
	]);
});

test('clicking a label selects the drawn nodes whose first label it is', () => {
	assert.deepEqual(nodeIdsOfLabel(model, 'Person'), ['1', '2']);
	assert.deepEqual(nodeIdsOfLabel(model, ''), ['4']);
	assert.deepEqual(nodeIdsOfLabel(model, 'Nope'), []);
});

test('with six labels or fewer, every label has its own chart colour (Product and Order never share one)', () => {
	for (const labels of [['Person', 'Product', 'Order'], ['Person', 'Product', 'Order', 'Company', 'Topic', 'Document'], ['Order', 'Product']]) {
		const colors = labelColors(EMPTY_STYLE, labels);
		const slots = [...colors.values()].map((c) => c.slot);
		assert.ok(slots.every((s) => s !== null), labels.join());
		assert.equal(new Set(slots).size, labels.length, labels.join());
	}
});

test('a label added later never changes the colour of one already assigned', () => {
	const first = labelColors({ ...EMPTY_STYLE, assigned: { Person: 1, Product: 2 } }, ['Person', 'Product']);
	const later = labelColors({ ...EMPTY_STYLE, assigned: { Person: 1, Product: 2 } }, ['Aardvark', 'Person', 'Product']);
	assert.equal(later.get('Person')?.fill, first.get('Person')?.fill);
	assert.equal(later.get('Product')?.fill, first.get('Product')?.fill);
	assert.notEqual(later.get('Aardvark')?.fill, later.get('Person')?.fill);
});

test('type colours: only the offered slots count, and an unstyled or invalid type keeps the ordinary line', () => {
	assert.deepEqual(TYPE_COLOR_SLOTS.slice().sort(), [0, 1, 2, 4]);
	const colors = typeColorsOf({ ...EMPTY_STYLE, types: { A: { slot: 0 }, B: { slot: 3 }, C: { slot: 5 }, D: {} } });
	assert.deepEqual([...colors.keys()], ['A']);
});

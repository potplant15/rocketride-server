// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LABEL STYLES: first-seen colour slots, colours under a style, style edits and
// the session-only user data
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHART_COLOR_VARS, assignLabelColors, hashColor, labelColors, nextAssignments } from '../src/graph/colors';
import { EMPTY_STYLE, applyStyleEdit, createMemoryUserData } from '../src/graph/userData';
import type { IConnectionStyle } from '../src/graph/userData';

const slotOf = (colors: ReadonlyMap<string, { slot: number | null }>, label: string): number | null | undefined => colors.get(label)?.slot;

test('nextAssignments gives new labels the lowest free slots in sorted order, and returns only the new ones', () => {
	assert.deepEqual(nextAssignments({}, ['Person', 'Company', 'Person']), { Company: 0, Person: 1 });
	// A later label sorted first does not take a held slot: it takes the lowest free one.
	assert.deepEqual(nextAssignments({ Company: 0, Person: 1 }, ['Aardvark', 'Company', 'Person']), { Aardvark: 2 });
	// A gap (a slot a person's file never held) is filled first.
	assert.deepEqual(nextAssignments({ A: 0, C: 2 }, ['B', 'D']), { B: 1, D: 3 });
	assert.deepEqual(nextAssignments({ Company: 0 }, ['Company']), {}, 'nothing new, nothing returned');
	assert.deepEqual(nextAssignments({}, ['']), {}, 'an unlabelled node takes no slot');
});

test('nextAssignments never gives a slot past the sixth: further labels stay hashed', () => {
	const six = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => [label, i]));
	assert.deepEqual(nextAssignments(six, ['G']), {});
	assert.deepEqual(Object.values(nextAssignments({}, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).sort(), [0, 1, 2, 3, 4, 5]);
});

test('labelColors with nothing stored is today\'s assignment', () => {
	const labels = ['Zebra', 'Apple', 'Mango', 'Cherry', 'Banana', 'Fig', 'Grape', 'Date'];
	assert.deepEqual(labelColors(EMPTY_STYLE, labels), assignLabelColors(labels));
});

test('labelColors keeps Person\'s slot when Aardvark appears, once the first run is stored', () => {
	const first = ['Company', 'Person'];
	const before = labelColors(EMPTY_STYLE, first);
	const style: IConnectionStyle = { ...EMPTY_STYLE, assigned: nextAssignments({}, first) };
	const after = labelColors({ ...style, assigned: { ...style.assigned, ...nextAssignments(style.assigned, ['Aardvark', ...first]) } }, ['Aardvark', ...first]);
	assert.equal(slotOf(after, 'Person'), slotOf(before, 'Person'));
	assert.equal(slotOf(after, 'Company'), slotOf(before, 'Company'));
	assert.equal(slotOf(after, 'Aardvark'), 2);
	// Without the stored assignment, today's rule would have moved them both.
	assert.notEqual(slotOf(assignLabelColors(['Aardvark', ...first]), 'Person'), slotOf(before, 'Person'));
});

test('labelColors: a person\'s slot comes first; a slot out of range is ignored; past six labels hash', () => {
	const style: IConnectionStyle = { assigned: { Person: 0, Company: 1 }, labels: { Person: { slot: 4 }, Company: { slot: 99 } }, types: {} };
	const colors = labelColors(style, ['Person', 'Company']);
	assert.deepEqual(colors.get('Person'), { label: 'Person', fill: `var(${CHART_COLOR_VARS[4]})`, slot: 4 });
	assert.equal(slotOf(colors, 'Company'), 1);
	const full: IConnectionStyle = { ...EMPTY_STYLE, assigned: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => [label, i])) };
	assert.deepEqual(labelColors(full, ['G']).get('G'), { label: 'G', fill: hashColor('G'), slot: null });
});

test('applyStyleEdit sets and clears one label or type, and reset keeps the first-seen slots', () => {
	const start: IConnectionStyle = { assigned: { Person: 0 }, labels: {}, types: {} };
	const styled = applyStyleEdit(start, { kind: 'label', label: 'Person', style: { slot: 3, size: 'L' } });
	assert.deepEqual(styled.labels, { Person: { slot: 3, size: 'L' } });
	const typed = applyStyleEdit(styled, { kind: 'type', type: 'KNOWS', style: { slot: 1 } });
	assert.deepEqual(typed.types, { KNOWS: { slot: 1 } });
	assert.deepEqual(applyStyleEdit(typed, { kind: 'label', label: 'Person', style: null }).labels, {});
	const reset = applyStyleEdit(typed, { kind: 'reset' });
	assert.deepEqual(reset, { assigned: { Person: 0 }, labels: {}, types: {} });
	assert.equal(applyStyleEdit(reset, { kind: 'reset' }), reset, 'nothing to reset: the same object');
	assert.deepEqual(start.labels, {}, 'the input is never changed');
});

test('session-only user data: one stable readable per key, edits applied and told, a rename of a missing query refused', async () => {
	let now = 1_000;
	const data = createMemoryUserData('kept for the session', () => now);
	assert.equal(data.privacyNote, 'kept for the session');
	assert.equal(data.style('k'), data.style('k'));
	assert.equal(data.saved('k'), data.saved('k'));
	assert.equal(data.style('k').get(), EMPTY_STYLE);
	assert.deepEqual(data.saved('k').get(), { status: 'session', queries: [], note: null });

	let told = 0;
	const off = data.style('k').subscribe(() => (told += 1));
	await data.editStyle('k', { kind: 'label', label: 'Person', style: { slot: 2 } });
	assert.equal(told, 1);
	assert.deepEqual(data.style('k').get().labels, { Person: { slot: 2 } });
	assert.equal(data.style('other').get(), EMPTY_STYLE, 'one connection\'s style is its own');
	off();

	await data.editSaved('k', { action: 'save', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c' });
	now = 2_000;
	await data.editSaved('k', { action: 'save', name: 'Second', cypher: 'RETURN 1' });
	const [newest, oldest] = data.saved('k').get().queries;
	assert.equal(newest.name, 'Second');
	assert.equal(oldest.savedAt, 1_000);
	await data.editSaved('k', { action: 'rename', id: oldest.id, name: 'Renamed' });
	assert.equal(data.saved('k').get().queries[1].name, 'Renamed');
	await assert.rejects(data.editSaved('k', { action: 'rename', id: 'gone', name: 'x' }));
	await data.editSaved('k', { action: 'delete', id: newest.id });
	assert.deepEqual(data.saved('k').get().queries.map((q) => q.name), ['Renamed']);
});

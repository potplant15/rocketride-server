// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA - the pure store: saved queries and label styles, their checks and
// their caps (saved queries ported from sql-ui's tests/savedQueries.test.ts)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import { memoryPrefs } from '../src/env';
import {
	MAX_SAVED_BAG_CHARS,
	MAX_SAVED_CYPHER_CHARS,
	MAX_SAVED_NAME_CHARS,
	MAX_SAVED_QUERIES,
	MAX_STYLES_BAG_CHARS,
	SAVED_QUERIES_PREF,
	STYLES_PREF,
	USER_DATA_PATH,
	applySavedEdit,
	applyStyleChange,
	checkSavedEdit,
	checkStyleEdit,
	editSavedIn,
	editStyleIn,
	readConnectionStyle,
	readSavedQueriesBag,
	savedQueriesIn,
	styleIn,
} from '../src/graph/userDataStore';
import type { ISavedQuery } from '../src/graph/userData';
import { EMPTY_STYLE } from '../src/graph/userData';

const KEY = 'k1|neo';
const OTHER = 'k2|falkor';

/** A saved query with a fixed id and time. */
const query = (id: string, name = `Query ${id}`, cypher = `MATCH (n) RETURN n LIMIT ${id.length}`): ISavedQuery => ({ id, name, cypher, savedAt: 1_000 });

/** The id and time a save is given. */
const made = (id: string) => ({ id, at: 1_000 });

/** A save of {@link query}. */
const save = (bag: Record<string, unknown>, key: string, q: ISavedQuery): Record<string, unknown> => applySavedEdit(bag, key, { action: 'save', name: q.name, cypher: q.cypher }, made(q.id));

/** One connection's queries as the reader shows them. */
const listOf = (bag: unknown, key: string): ISavedQuery[] => readSavedQueriesBag(bag)[key] ?? [];

/**
 * Whether a failure is the store's refusal, worded as the user reads it.
 *
 * @param pattern - What the message says.
 * @returns The throws predicate.
 */
const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ExplorerToolError && error.kind === 'invalid' && pattern.test(error.message);

describe('user data: the persisted names never change', () => {
	it('keeps saved queries under graph.savedQueries and styles under graph.styles, keyed by connection; the dev tool\'s file sits beside the history file', () => {
		assert.equal(SAVED_QUERIES_PREF, 'graph.savedQueries');
		assert.equal(STYLES_PREF, 'graph.styles');
		assert.equal(USER_DATA_PATH, '@/User/.workspace/rocketride.graph.saved.json');
		const prefs = memoryPrefs();
		editSavedIn(prefs, KEY, { action: 'save', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c' }, made('a'));
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [{ id: 'a', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c', savedAt: 1_000 }] });
		editStyleIn(prefs, KEY, { kind: 'label', label: 'Person', style: { slot: 4 } });
		assert.deepEqual(prefs.getPref(STYLES_PREF), { [KEY]: { assigned: {}, labels: { Person: { slot: 4 } }, types: {} } });
	});
});

describe('saved queries: save, rename, delete', () => {
	it('saves newest first, per connection, and never touches another connection', () => {
		let bag: Record<string, unknown> = { [OTHER]: [query('x')] };
		bag = save(bag, KEY, query('a'));
		bag = save(bag, KEY, query('b'));
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'a']);
		assert.deepEqual(bag[OTHER], [query('x')]);
	});

	it('a save that repeats an id replaces that query in place (a call sent twice saves once)', () => {
		let bag = save({}, KEY, query('a'));
		bag = save(bag, KEY, query('b'));
		bag = save(bag, KEY, query('a', 'Renamed', 'RETURN 2'));
		assert.deepEqual(listOf(bag, KEY), [query('b'), query('a', 'Renamed', 'RETURN 2')]);
	});

	it('renames in place, trimmed; a query that is gone is refused, not created', () => {
		let bag = save({}, KEY, query('a'));
		bag = applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '  Who works where  ' }, made('unused'));
		assert.equal(listOf(bag, KEY)[0]!.name, 'Who works where');
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'gone', name: 'x' }, made('unused')), refused(/no longer exists/));
	});

	it('deletes one; deleting the last drops the connection; an unknown id changes nothing', () => {
		let bag = save({}, KEY, query('a'));
		assert.equal(applySavedEdit(bag, KEY, { action: 'delete', id: 'gone' }, made('unused')), bag);
		bag = applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.deepEqual(bag, {});
	});

	it('never changes the bag it was given', () => {
		const bag = { [KEY]: [query('a')] };
		const before = JSON.stringify(bag);
		save(bag, KEY, query('b'));
		applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: 'New' }, made('unused'));
		applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.equal(JSON.stringify(bag), before);
	});
});

describe('saved queries: the caps refuse a save and keep everything already saved', () => {
	it(`keeps at most ${MAX_SAVED_QUERIES} per connection`, () => {
		let bag: Record<string, unknown> = {};
		for (let i = 0; i < MAX_SAVED_QUERIES; i += 1) bag = save(bag, KEY, query(`q${i}`));
		assert.throws(() => save(bag, KEY, query('one-more')), refused(new RegExp(`already keeps ${MAX_SAVED_QUERIES} saved queries\\. Delete one to save another\\.`)));
		assert.equal(listOf(bag, KEY).length, MAX_SAVED_QUERIES);
		assert.doesNotThrow(() => save(bag, OTHER, query('one-more')), 'another connection has its own count');
		assert.doesNotThrow(() => save(bag, KEY, query('q3', 'Again')), 'replacing one by id is not a new one');
	});

	it(`holds at most ${MAX_SAVED_CYPHER_CHARS} characters of statement and ${MAX_SAVED_NAME_CHARS} of name`, () => {
		assert.equal(MAX_SAVED_CYPHER_CHARS, 16 * 1024);
		assert.equal(MAX_SAVED_NAME_CHARS, 120);
		const long = `RETURN '${'x'.repeat(MAX_SAVED_CYPHER_CHARS)}'`;
		assert.throws(() => save({}, KEY, query('a', 'Long', long)), refused(/holds at most 16,384 characters, and this one has/));
		assert.doesNotThrow(() => save({}, KEY, query('a', 'Fits', 'x'.repeat(MAX_SAVED_CYPHER_CHARS))));
		assert.throws(() => save({}, KEY, query('a', 'n'.repeat(MAX_SAVED_NAME_CHARS + 1))), refused(/a name holds at most 120 characters/));
		const bag = save({}, KEY, query('a'));
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: 'n'.repeat(MAX_SAVED_NAME_CHARS + 1) }, made('unused')), refused(/a name holds at most 120 characters/));
	});

	it('refuses an empty name or an empty statement', () => {
		assert.throws(() => save({}, KEY, query('a', '   ')), refused(/give it a name/));
		assert.throws(() => save({}, KEY, query('a', 'Empty', ' \n ')), refused(/no statement to save/));
		const bag = save({}, KEY, query('a'));
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '' }, made('unused')), refused(/give it a name/));
	});

	it(`keeps the whole bag within ${MAX_SAVED_BAG_CHARS} characters as the file is written (indented)`, () => {
		assert.equal(MAX_SAVED_BAG_CHARS, 256 * 1024);
		const big = 'x'.repeat(15_000);
		let bag: Record<string, unknown> = {};
		let refusedAt = -1;
		for (let i = 0; i < 40; i += 1) {
			try {
				bag = save(bag, `conn-${i}`, query(`q${i}`, 'Big', big));
			} catch (error) {
				assert.ok(refused(/saved queries are full \(256 KB across all connections\)\. Delete some to save more\./)(error));
				refusedAt = i;
				break;
			}
		}
		assert.ok(refusedAt > 0, 'the bag cap refused a save');
		assert.ok(JSON.stringify(bag, null, 2).length <= MAX_SAVED_BAG_CHARS, 'what is kept stays within the cap');
		assert.equal(Object.keys(bag).length, refusedAt, 'nothing already saved was dropped');
	});
});

describe('saved queries: a name is one plain line', () => {
	it('collapses line breaks and runs of white space, and drops control characters and direction overrides', () => {
		const bag = save({}, KEY, query('a', 'ok\n‮evil\u0000'));
		assert.equal(listOf(bag, KEY)[0]!.name, 'ok evil');
		const renamed = applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '\tWho\r\n works ⁦where⁩‏ ' }, made('unused'));
		assert.equal(listOf(renamed, KEY)[0]!.name, 'Who works where');
	});

	it('a name made only of such characters is no name', () => {
		assert.throws(() => save({}, KEY, query('a', '‮\u0007\n')), refused(/give it a name/));
	});
});

describe('saved queries: a write keeps what this build cannot read', () => {
	it('entries it cannot parse, and fields it does not know, survive a save, a rename and a delete', () => {
		const newer = { ...query('n'), tags: ['finance'] };
		const damaged = { id: 'd', name: 'No time', cypher: 'RETURN 9' };
		const stored = { [KEY]: [newer, damaged, 'junk', query('a')], [OTHER]: [{ format: 2 }] };
		let bag = save(stored, KEY, query('b'));
		bag = applySavedEdit(bag, KEY, { action: 'rename', id: 'n', name: 'Renamed' }, made('unused'));
		bag = applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.deepEqual(bag[KEY], [query('b'), { ...newer, name: 'Renamed' }, damaged, 'junk']);
		assert.deepEqual(bag[OTHER], [{ format: 2 }], 'another connection\'s list is untouched');
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'n'], 'the reader shows what it can');
	});

	it('the count cap counts the queries a user can see', () => {
		const stored = { [KEY]: [...Array.from({ length: MAX_SAVED_QUERIES - 1 }, (_, i) => query(`q${i}`)), { id: 'hidden' }] };
		assert.doesNotThrow(() => save(stored, KEY, query('last')));
	});

	it('through an accessor too: the stored value keeps them', () => {
		const prefs = memoryPrefs();
		prefs.setPref(SAVED_QUERIES_PREF, { [KEY]: [{ id: 'x', future: true }] });
		editSavedIn(prefs, KEY, { action: 'save', name: 'Query a', cypher: query('a').cypher }, made('a'));
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [query('a'), { id: 'x', future: true }] });
	});
});

describe('saved queries: reading what is stored', () => {
	it('keeps well-formed queries and drops anything else, without throwing', () => {
		const stored = { [KEY]: [query('a'), { id: 'b' }, null, 7, query('c')], [OTHER]: 'not a list', empty: [] };
		assert.deepEqual(readSavedQueriesBag(stored), { [KEY]: [query('a'), query('c')] });
		for (const junk of [undefined, null, 'x', [query('a')], 3]) assert.deepEqual(readSavedQueriesBag(junk), {});
	});

	it('reads one connection through an accessor, empty for an unknown one; a refused edit writes nothing', () => {
		const prefs = memoryPrefs();
		assert.deepEqual(savedQueriesIn(prefs, KEY), []);
		editSavedIn(prefs, KEY, { action: 'save', name: 'Query a', cypher: query('a').cypher }, made('a'));
		assert.deepEqual(savedQueriesIn(prefs, KEY), [query('a')]);
		assert.deepEqual(savedQueriesIn(prefs, OTHER), []);
		const before = prefs.getPref(SAVED_QUERIES_PREF);
		assert.throws(() => editSavedIn(prefs, KEY, { action: 'rename', id: 'gone', name: 'x' }, made('unused')));
		assert.equal(prefs.getPref(SAVED_QUERIES_PREF), before);
	});
});

describe('styles: what is stored, read back clean', () => {
	it('keeps valid slots, sizes and badges, and drops anything else without throwing', () => {
		const raw = { assigned: { Person: 0, Company: 7, Odd: 1.5, Bad: '2', Topic: 5 }, labels: { Person: { slot: 3, size: 'L', badge: 'dot', glow: true }, Junk: 'x', Empty: { slot: 9 } }, types: { KNOWS: { slot: 2 }, BAD: { slot: -1 } }, future: 1 };
		assert.deepEqual(readConnectionStyle(raw), { assigned: { Person: 0, Topic: 5 }, labels: { Person: { slot: 3, size: 'L', badge: 'dot' } }, types: { KNOWS: { slot: 2 } } });
		for (const junk of [undefined, null, 'x', [], 3]) assert.deepEqual(readConnectionStyle(junk), EMPTY_STYLE);
	});

	it('a connection nobody styled reads as the empty style, the same object each time', () => {
		const prefs = memoryPrefs();
		assert.equal(styleIn(prefs, KEY), EMPTY_STYLE);
	});
});

describe('styles: edits and first-seen slots', () => {
	it('a label or type edit sets or clears that one; reset clears the choices and keeps the first-seen slots', () => {
		let bag: Record<string, unknown> = { [OTHER]: { labels: { X: { slot: 1 } } } };
		bag = applyStyleChange(bag, KEY, { kind: 'assign', assigned: { Person: 0, Company: 1 } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', style: { slot: 4, size: 'S' } });
		bag = applyStyleChange(bag, KEY, { kind: 'type', type: 'KNOWS', style: { slot: 2 } });
		assert.deepEqual(readConnectionStyle(bag[KEY]), { assigned: { Person: 0, Company: 1 }, labels: { Person: { slot: 4, size: 'S' } }, types: { KNOWS: { slot: 2 } } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', style: null });
		assert.deepEqual(readConnectionStyle(bag[KEY]).labels, {});
		bag = applyStyleChange(bag, KEY, { kind: 'reset' });
		assert.deepEqual(readConnectionStyle(bag[KEY]), { assigned: { Person: 0, Company: 1 }, labels: {}, types: {} });
		assert.deepEqual(bag[OTHER], { labels: { X: { slot: 1 } } }, 'another connection is untouched');
	});

	it('an assignment only adds: a slot already given is never moved', () => {
		let bag = applyStyleChange({}, KEY, { kind: 'assign', assigned: { Person: 0 } });
		bag = applyStyleChange(bag, KEY, { kind: 'assign', assigned: { Person: 3, Aardvark: 1 } });
		assert.deepEqual(readConnectionStyle(bag[KEY]).assigned, { Person: 0, Aardvark: 1 });
		assert.equal(applyStyleChange(bag, KEY, { kind: 'assign', assigned: {} }), bag, 'nothing new: the same bag');
	});

	it('a write keeps what this build cannot read: fields it does not know, here and in another connection', () => {
		const stored = { [KEY]: { assigned: { Person: 0 }, labels: { Person: { slot: 2, ring: 'gold' } }, future: { a: 1 } }, [OTHER]: 'v2-format' };
		const bag = applyStyleChange(stored, KEY, { kind: 'label', label: 'Company', style: { badge: 'none' } });
		assert.deepEqual(bag[KEY], { assigned: { Person: 0 }, labels: { Person: { slot: 2, ring: 'gold' }, Company: { badge: 'none' } }, types: {}, future: { a: 1 } });
		assert.equal(bag[OTHER], 'v2-format');
	});

	it(`refuses a person's edit past ${MAX_STYLES_BAG_CHARS} characters; an assignment past it is skipped, never an error`, () => {
		assert.equal(MAX_STYLES_BAG_CHARS, 64 * 1024);
		const long = 'L'.repeat(1_000);
		let bag: Record<string, unknown> = {};
		let refusedAt = -1;
		for (let i = 0; i < 200; i += 1) {
			try {
				bag = applyStyleChange(bag, KEY, { kind: 'label', label: `${long}${i}`, style: { slot: 1 } });
			} catch (error) {
				assert.ok(refused(/styles are full \(64 KB across all connections\)\. Reset the styles of a connection to make room\./)(error));
				refusedAt = i;
				break;
			}
		}
		assert.ok(refusedAt > 0, 'the cap refused an edit');
		assert.equal(applyStyleChange(bag, OTHER, { kind: 'assign', assigned: { [`${long}x`]: 0 } }), bag, 'an assignment that does not fit is skipped');
		assert.doesNotThrow(() => applyStyleChange(bag, KEY, { kind: 'reset' }), 'a reset always fits');
	});
});

describe('user data: what may cross from a frame', () => {
	it('accepts the edits this app makes and rebuilds them with their own fields only', () => {
		assert.deepEqual(checkSavedEdit({ action: 'save', name: 'N', cypher: 'RETURN 1', extra: 1 }), { action: 'save', name: 'N', cypher: 'RETURN 1' });
		assert.deepEqual(checkSavedEdit({ action: 'rename', id: 'a', name: 'B' }), { action: 'rename', id: 'a', name: 'B' });
		assert.deepEqual(checkSavedEdit({ action: 'delete', id: 'a' }), { action: 'delete', id: 'a' });
		assert.deepEqual(checkStyleEdit({ kind: 'label', label: 'Person', style: { slot: 2, size: 'M', badge: 'initials', glow: 1 } }), { kind: 'label', label: 'Person', style: { slot: 2, size: 'M', badge: 'initials' } });
		assert.deepEqual(checkStyleEdit({ kind: 'label', label: 'Person', style: null }), { kind: 'label', label: 'Person', style: null });
		assert.deepEqual(checkStyleEdit({ kind: 'type', type: 'KNOWS', style: { slot: 0 } }), { kind: 'type', type: 'KNOWS', style: { slot: 0 } });
		assert.deepEqual(checkStyleEdit({ kind: 'reset' }), { kind: 'reset' });
	});

	it('refuses anything else, an assignment included (only the owning realm assigns)', () => {
		for (const bad of [null, 'save', {}, { action: 'clear' }, { action: 'delete' }, { action: 'delete', id: '' }, { action: 'rename', id: 'a' }, { action: 'save', name: 'n' }, { action: 'save', name: 1, cypher: 'x' }]) {
			assert.throws(() => checkSavedEdit(bad), refused(/not one this app makes/), JSON.stringify(bad));
		}
		for (const bad of [null, {}, { kind: 'assign', assigned: { A: 0 } }, { kind: 'label', style: {} }, { kind: 'label', label: 'P', style: { slot: 6 } }, { kind: 'label', label: 'P', style: { size: 'XL' } }, { kind: 'label', label: 'P', style: { badge: 'star' } }, { kind: 'type', type: 'T', style: { slot: 1.5 } }, { kind: 'type', type: 'T', style: { size: 'S' } }, { kind: 'label', label: 'P', style: 'red' }]) {
			assert.throws(() => checkStyleEdit(bad), refused(/not one this app makes/), JSON.stringify(bad));
		}
	});
});

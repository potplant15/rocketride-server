// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA IN THE FULL APP - the workspace preferences behind the page's pin
// (ported from sql-ui's tests/fullAppIdentity.test.ts), the stored user data's
// reads, and the first-seen colour slots
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IDataGridPersistence } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IPrefsAccessor } from 'shared/explorer';
import { createSchemaStore } from '../src/graph/schemaStore';
import { APP_USER_DATA_NOTE, EMPTY_STYLE, SESSION_USER_DATA_NOTE, createMemoryUserData, devToolUserDataNote, followAssignments } from '../src/graph/userData';
import { SAVED_QUERIES_PREF, STYLES_PREF } from '../src/graph/userDataStore';
import { ANOTHER_ACCOUNT_USER_DATA, createAppUserData, createWorkspacePin, pinnedGrids, pinnedPrefs } from '../src/graph/workspacePin';
import { fixture } from './support/builders';

const KEY = 'k1|neo';
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';

/**
 * The shell's workspace preferences as the full app sees them: read once per page from the first account's file, and
 * the whole bag written back through whoever is signed in when any key changes.
 *
 * @param first - The account signed in when the page read its preferences.
 * @returns The model.
 */
function shellModel(first: string | null) {
	let owner = first;
	const bag = new Map<string, unknown>();
	const files = new Map<string, string>();
	const prefs: IPrefsAccessor = {
		getPref: (key) => bag.get(key),
		setPref: (key, value) => {
			bag.set(key, value);
			if (owner !== null) files.set(owner, JSON.stringify(Object.fromEntries(bag)));
		},
	};
	return { prefs, bag, files, owner: () => owner, signIn: (next: string | null) => { owner = next; } };
}

describe('full app: A, then B without a reload', () => {
	it('B is served none of A\'s styles or saved queries, nothing is written while B is signed in, and B\'s file never holds A\'s', async () => {
		const shell = shellModel(FP_A);
		const data = createAppUserData(shell.prefs, shell.owner, createWorkspacePin());
		await data.editSaved(KEY, { action: 'save', name: 'A payroll', cypher: "MATCH (p:Person {name: 'Alice'}) RETURN p.salary" });
		await data.editStyle(KEY, { kind: 'label', label: 'Person', style: { slot: 4 } });
		assert.match(shell.files.get(FP_A) ?? '', /A payroll/);
		assert.equal(data.saved(KEY).get().status, 'ready');
		assert.equal(data.privacyNote, APP_USER_DATA_NOTE);

		shell.signIn(FP_B);
		data.notify();
		const filesBefore = new Map(shell.files);
		assert.deepEqual(data.saved(KEY).get(), { status: 'error', queries: [], note: ANOTHER_ACCOUNT_USER_DATA }, 'B is never shown A\'s saved queries');
		assert.equal(data.style(KEY).get(), EMPTY_STYLE, 'or A\'s styles');
		await assert.rejects(data.editSaved(KEY, { action: 'save', name: 'B query', cypher: 'RETURN 2' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale' && /different account/.test(error.message));
		await assert.rejects(data.editStyle(KEY, { kind: 'reset' }), (error: unknown) => error instanceof ExplorerToolError && /different account/.test(error.message));
		data.assign(KEY, ['Company']);
		assert.equal(shell.files.has(FP_B), false, 'nothing was written while B is signed in');
		assert.deepEqual(shell.files, filesBefore);
	});

	it('A, back again before a reload, is served A\'s own and can save again', async () => {
		const shell = shellModel(FP_A);
		const data = createAppUserData(shell.prefs, shell.owner, createWorkspacePin());
		await data.editSaved(KEY, { action: 'save', name: 'Mine', cypher: 'RETURN 1' });
		shell.signIn(FP_B);
		data.notify();
		shell.signIn(FP_A);
		data.notify();
		assert.deepEqual(data.saved(KEY).get().queries.map((q) => q.name), ['Mine']);
		await data.editSaved(KEY, { action: 'save', name: 'Again', cypher: 'RETURN 2' });
		assert.equal(data.saved(KEY).get().queries.length, 2);
	});

	it('signed out, nothing is read or written either', async () => {
		const shell = shellModel(null);
		shell.bag.set(SAVED_QUERIES_PREF, { [KEY]: [{ id: 'x', name: 'X', cypher: 'RETURN 1', savedAt: 1 }] });
		const data = createAppUserData(shell.prefs, shell.owner, createWorkspacePin());
		assert.deepEqual(data.saved(KEY).get(), { status: 'error', queries: [], note: 'Not signed in to a RocketRide server.' });
		await assert.rejects(data.editSaved(KEY, { action: 'delete', id: 'x' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
	});
});

describe('full app: one pin per page, over every preference Graph Explorer keeps itself', () => {
	it('the first account seen binds; nobody and another account read nothing and write nothing', () => {
		const pin = createWorkspacePin();
		assert.equal(pin.access(null), 'nobody', 'nobody binds nothing');
		assert.equal(pin.access(FP_A), 'owner');
		assert.equal(pin.access(FP_B), 'another');
		assert.equal(pin.access(FP_A), 'owner', 'the first account back is served its own bag');
	});

	it('pinnedPrefs and pinnedGrids pass through for the pinned account only', () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		const prefs = pinnedPrefs(pin, shell.prefs, shell.owner);
		const layouts = new Map<string, unknown>();
		const writes: string[] = [];
		const inner: IDataGridPersistence = {
			read: (id, type) => layouts.get(`${id}/${type}`) ?? false,
			write: (id, type, data) => {
				writes.push(`write ${id}/${type}`);
				layouts.set(`${id}/${type}`, data);
			},
			clear: (id) => {
				writes.push(`clear ${id}`);
			},
		};
		const grids = pinnedGrids(pin, inner, shell.owner);
		prefs.setPref('graph.drafts', { [KEY]: 'MATCH (n) RETURN n' });
		grids.write('t', 'sort', [1]);
		assert.deepEqual(prefs.getPref('graph.drafts'), { [KEY]: 'MATCH (n) RETURN n' });
		assert.deepEqual(grids.read('t', 'sort'), [1]);
		shell.signIn(FP_B);
		assert.equal(prefs.getPref('graph.drafts'), undefined, 'B reads none of A\'s drafts');
		assert.equal(grids.read('t', 'sort'), false, 'or A\'s layouts');
		prefs.setPref('graph.drafts', { [KEY]: 'B' });
		grids.write('t', 'sort', [2]);
		grids.clear('t');
		assert.deepEqual(shell.bag.get('graph.drafts'), { [KEY]: 'MATCH (n) RETURN n' }, 'and writes nothing');
		assert.deepEqual(writes, ['write t/sort']);
	});
});

describe('stored user data: reads are stable, and say where they are', () => {
	it('one readable per key, the same snapshot until something changes, even when the host hands out a new object for the same value', async () => {
		let bag: Record<string, unknown> = {};
		// A host that copies the value on every read (as JSON would).
		const prefs: IPrefsAccessor = { getPref: (key) => (bag[key] === undefined ? undefined : JSON.parse(JSON.stringify(bag[key]))), setPref: (key, value) => { bag = { ...bag, [key]: value }; } };
		const data = createAppUserData(prefs, () => FP_A, createWorkspacePin());
		await data.editStyle(KEY, { kind: 'label', label: 'Person', style: { slot: 1 } });
		await data.editSaved(KEY, { action: 'save', name: 'One', cypher: 'RETURN 1' });
		assert.equal(data.style(KEY), data.style(KEY));
		assert.equal(data.style(KEY).get(), data.style(KEY).get(), 'a stable style snapshot');
		assert.equal(data.saved(KEY).get(), data.saved(KEY).get(), 'a stable saved-queries snapshot');
		const before = data.saved(KEY).get();
		await data.editSaved(KEY, { action: 'save', name: 'Two', cypher: 'RETURN 2' });
		assert.notEqual(data.saved(KEY).get(), before, 'a change is a new snapshot');
	});

	it('a change tells every subscriber once it is written; a refusal writes nothing and tells nobody', async () => {
		const data = createMemoryUserData('session');
		let told = 0;
		const off = data.saved(KEY).subscribe(() => (told += 1));
		await data.editSaved(KEY, { action: 'save', name: 'One', cypher: 'RETURN 1' });
		assert.equal(told, 1);
		await assert.rejects(data.editSaved(KEY, { action: 'save', name: '', cypher: 'RETURN 1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		assert.equal(told, 1);
		off();
	});
});

describe('first-seen colour slots: given once, in the realm that owns the schema', () => {
	it('followAssignments stores the slots of a loaded schema\'s labels, and a later new label takes a free slot without moving any', async () => {
		const schemas = createSchemaStore(() => 1);
		const data = createMemoryUserData('session');
		const off = followAssignments(schemas, data);
		const two = { version: 2, labels: [{ name: 'Person', properties: [] }, { name: 'Company', properties: [] }], relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'startup', stale: false, error: null, capable: true };
		await schemas.load(KEY, async () => ({ schema: two }), () => ({ variant: 'error', headline: '', detail: '', verbatim: '', generic: false, hint: null, ignore: false }));
		assert.deepEqual(data.style(KEY).get().assigned, { Company: 0, Person: 1 });
		await schemas.load(KEY, async () => ({ schema: { ...two, labels: [{ name: 'Aardvark', properties: [] }, ...two.labels] } }), () => ({ variant: 'error', headline: '', detail: '', verbatim: '', generic: false, hint: null, ignore: false }), { refresh: true });
		assert.deepEqual(data.style(KEY).get().assigned, { Company: 0, Person: 1, Aardvark: 2 });
		off();
	});

	it('nothing is assigned where nothing can be written (another account in the full app), and it is once the account is back', async () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		pin.access(FP_A);
		shell.signIn(FP_B);
		const data = createAppUserData(shell.prefs, shell.owner, pin);
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => fixture('schema_v2'), () => ({ variant: 'error', headline: '', detail: '', verbatim: '', generic: false, hint: null, ignore: false }));
		assert.equal(shell.bag.get(STYLES_PREF), undefined, 'nothing written for B');
		shell.signIn(FP_A);
		data.notify();
		assert.ok(Object.keys(data.style(KEY).get().assigned).length > 0, 'assigned for A');
		off();
	});
});

describe('where each mount says it keeps them', () => {
	it('one true sentence or two per mount, each under 160 characters', () => {
		const notes = [APP_USER_DATA_NOTE, SESSION_USER_DATA_NOTE, devToolUserDataNote('file'), devToolUserDataNote('session'), devToolUserDataNote('none')];
		for (const note of notes) assert.ok(note.length <= 160, `${note.length}: ${note}`);
		assert.match(APP_USER_DATA_NOTE, /workspace file on the server, for your account/);
		assert.match(devToolUserDataNote('file'), /rocketride\.graph\.saved\.json/);
		assert.match(devToolUserDataNote('file'), /the last one wins/);
		assert.match(devToolUserDataNote('session'), /^Kept for this session only/);
		assert.match(devToolUserDataNote('none'), /nobody is signed in/);
	});
});

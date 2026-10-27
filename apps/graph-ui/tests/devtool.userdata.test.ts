// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA IN A DEV TOOL - where styles and saved queries are kept, and whose
// they are (ported from sql-ui's tests/devtool.savedQueries.test.ts)
// =============================================================================
//
// The controller keeps label styles and saved queries in their own per-user
// file, `@/User/.workspace/rocketride.graph.saved.json`, one bag per account
// (the dev-tool library's createFsPrefs, a second accessor beside history's).
// Frames read them with `graph.userData` and change them with
// `graph.userDataEdit`, both owned calls, and follow the retained `userData`
// topic's revision. The identity cases follow T7 for history: nothing is
// served to, or written for, another account, in any order the account can
// change. Frames also read the full schema view with `graph.schemaView`, on
// first use and after every newer load.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import { PREFS_FILE_VERSION, PREFS_FS_TIMEOUT_MS, PREFS_LOAD_ATTEMPTS } from 'shared/explorer/devtool/prefs';
import { jsonByteLength } from 'shared/explorer/devtool/state';
import { assertJsonSafe } from 'shared/explorer/devtool/testing';
import { OP, STATE, USER_DATA_LOAD_WAIT_MS, frameTimeoutFor } from '../src/devtool/protocol';
import type { UserDataChange } from '../src/devtool/protocol';
import { parseSchema } from '../src/graph/schema';
import type { ISavedQuery } from '../src/graph/userData';
import { MAX_SAVED_QUERIES, SAVED_QUERIES_PREF, STYLES_PREF, USER_DATA_PATH } from '../src/graph/userDataStore';
import { NEO4J_SCHEMA, account, mountController, mountFrame, readOnlyNode, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import type { IToolCall } from 'shared/explorer/connect/testing';

const FP_A = 'u1|org-1|team-1';

/** Every request for the user-data file. */
const fileRequests = (engine: { requests: Array<{ op: string; params: unknown }> }, op: string) => engine.requests.filter((r) => r.op === op && (r.params as { path?: string } | null)?.path === USER_DATA_PATH);

/**
 * What one account's bag holds in the file.
 *
 * @param files - The user store.
 * @param owner - The account.
 * @returns Its preferences, or undefined.
 */
function bagOf(files: Map<string, unknown>, owner: string): Record<string, unknown> | undefined {
	const file = files.get(USER_DATA_PATH) as { owners?: Record<string, { prefs?: Record<string, unknown> }> } | undefined;
	return file?.owners?.[owner]?.prefs;
}

/**
 * A signed-in VS Code realm, its controller and one frame on the connection's workbench, discovery done.
 *
 * @param behave - The node.
 * @returns The rig.
 */
async function rig(behave: (call: IToolCall) => unknown = readOnlyNode) {
	const engine = vscodeRealm(undefined, behave);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm);
	mounted.h.setHostConnection(true);
	const landing = mountFrame(mounted.h, undefined);
	await until(() => landing.frame.env(true).endpoints.get().endpoints.length === 1 && Object.keys(landing.frame.env(true).endpoints.get().probes).length === 1, 'discovery and the probe');
	const key = landing.frame.env(true).endpoints.get().endpoints[0].key;
	const doc = mountFrame(mounted.h, `workbench:${key}`);
	await until(() => doc.frame.guard.first() !== null, 'the frame learnt its account');
	const read = (owner: string | null) => doc.frame.caller.callReply(OP.userData, { key, owner }, { timeoutMs: frameTimeoutFor(OP.userData) });
	const change = (owner: string | null, edit: UserDataChange) => doc.frame.caller.callReply(OP.userDataEdit, { key, owner, change: edit }, { timeoutMs: frameTimeoutFor(OP.userDataEdit) });
	return {
		engine, ...mounted, landing: landing.frame, frame: doc.frame, key, read, change,
		dispose() {
			doc.frame.dispose();
			landing.frame.dispose();
			mounted.controller.dispose();
		},
	};
}

/** Wait until the frame's view of the saved queries is no longer loading. */
async function loaded(view: { get(): { status: string } }, what = 'the saved queries read'): Promise<void> {
	await until(() => view.get().status !== 'loading', what, 200);
}

/** A change saved through the op, as a frame sends it. */
const saveOf = (name: string, cypher = 'MATCH (p:Person) RETURN p'): UserDataChange => ({ target: 'saved', edit: { action: 'save', name, cypher } });

/** The file was written (after the library's debounce). */
const written = (engine: { requests: Array<{ op: string; params: unknown }> }, count = 1) => until(() => fileRequests(engine, 'client.fsWriteJson').length >= count, 'the user-data file written', 200);

describe('user data in a dev tool: the controller keeps it in its own file, per account', () => {
	it('names the file beside the history file, and waits for it as long as the library may take to read it', () => {
		assert.equal(USER_DATA_PATH, '@/User/.workspace/rocketride.graph.saved.json');
		assert.equal(USER_DATA_LOAD_WAIT_MS, PREFS_LOAD_ATTEMPTS * 2 * PREFS_FS_TIMEOUT_MS + 1_000 + 3_000, 'the library\'s whole load');
		assert.ok(frameTimeoutFor(OP.userData) > USER_DATA_LOAD_WAIT_MS && frameTimeoutFor(OP.userDataEdit) > USER_DATA_LOAD_WAIT_MS, 'the frame waits longer than the controller may');
	});

	it('a frame\'s save and style land in the file under the signed-in account, beside the history file, not in it; the frame reads them back with where they are kept', async () => {
		const r = await rig();
		const view = r.frame.env(true).userData.saved(r.key);
		const off = view.subscribe(() => undefined);
		await loaded(view);
		assert.equal(view.get().status, 'ready');
		await r.change(FP_A, saveOf('Who works where'));
		await r.change(FP_A, { target: 'style', edit: { kind: 'label', label: 'Person', style: { slot: 4, size: 'L' } } });
		await until(() => view.get().queries.length === 1, 'the frame read its save back');
		assert.equal(view.get().queries[0].name, 'Who works where');
		assert.match(r.frame.env(true).userData.privacyNote, /rocketride\.graph\.saved\.json/);
		await written(r.engine);
		await until(() => (bagOf(r.engine.files, FP_A)?.[STYLES_PREF] as Record<string, unknown> | undefined)?.[r.key] !== undefined, 'the style in the file', 200);
		const bag = bagOf(r.engine.files, FP_A) ?? {};
		assert.deepEqual((bag[SAVED_QUERIES_PREF] as Record<string, ISavedQuery[]>)[r.key].map((q) => q.name), ['Who works where']);
		assert.deepEqual(((bag[STYLES_PREF] as Record<string, { labels: unknown }>)[r.key]).labels, { Person: { slot: 4, size: 'L' } });
		assert.equal((r.engine.files.get(USER_DATA_PATH) as { version: number }).version, PREFS_FILE_VERSION);
		assert.doesNotMatch(JSON.stringify([...r.engine.files.entries()].filter(([path]) => path !== USER_DATA_PATH)), /Who works where/, 'the history file holds none of it');
		off();
		r.dispose();
	});

	it('the caps refuse a save through the op with the sentence, and an edit this app does not make is refused', async () => {
		const r = await rig();
		for (let i = 0; i < MAX_SAVED_QUERIES; i += 1) await r.change(FP_A, saveOf(`q${i}`));
		await assert.rejects(r.change(FP_A, saveOf('one more')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /already keeps 50 saved queries/.test(error.message));
		await assert.rejects(r.change(FP_A, { target: 'style', edit: { kind: 'assign', assigned: { X: 0 } } } as never), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', 'an assignment never comes from a frame');
		await assert.rejects(r.change(FP_A, { target: 'history' } as never), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		r.dispose();
	});

	it('never writes a file it could not read: they are kept for the session, and the answer says so', async () => {
		const engine = vscodeRealm();
		engine.files.set(USER_DATA_PATH, { format: 'from the future' });
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.env(true).endpoints.get().endpoints.length === 1, 'discovery');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await until(() => frame.guard.first() !== null, 'the frame learnt its account');
		await frame.caller.callReply(OP.userDataEdit, { key, owner: FP_A, change: saveOf('Kept') }, { timeoutMs: frameTimeoutFor(OP.userDataEdit) });
		const answer = await frame.caller.callReply(OP.userData, { key, owner: FP_A }, { timeoutMs: frameTimeoutFor(OP.userData) });
		assert.equal(answer.saved.status, 'session');
		assert.deepEqual(answer.saved.queries.map((q) => q.name), ['Kept']);
		assert.match(answer.privacyNote, /^Kept for this session only/);
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.deepEqual(fileRequests(engine, 'client.fsWriteJson'), [], 'the file was never written');
		assert.deepEqual(engine.files.get(USER_DATA_PATH), { format: 'from the future' });
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('user data: frames follow a small revision topic, and read the data as an op result', () => {
	it('the revision moves on every change; the topic carries no data and stays under 64 bytes; the ops round-trip JSON-safe', async () => {
		const r = await rig();
		const revs = (): number[] => r.h.wire.flatMap((entry) => Object.values((entry.value ?? {}) as Record<string, { __rrtool?: string; topic?: string; snapshot?: { rev: number } }>).filter((m) => m?.__rrtool === 'state' && m.topic === STATE.userData).map((m) => m.snapshot!.rev));
		const before = Math.max(...revs());
		await r.change(FP_A, saveOf('Who works where'));
		await until(() => Math.max(...revs()) > before, 'the revision moved');
		for (const entry of r.h.wire) {
			for (const m of Object.values((entry.value ?? {}) as Record<string, { __rrtool?: string; topic?: string; snapshot?: unknown }>)) {
				if (m?.__rrtool !== 'state' || m.topic !== STATE.userData) continue;
				assert.deepEqual(Object.keys(m.snapshot as object), ['rev']);
				assert.ok(jsonByteLength(m.snapshot) < 64, 'a tiny topic');
				assert.doesNotMatch(JSON.stringify(m.snapshot), /Who works where/);
			}
		}
		await r.read(FP_A);
		for (const [i, entry] of r.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		assert.deepEqual(r.h.violations, [], 'nothing JSON would change crossed the wire');
		r.dispose();
	});

	it('a second document\'s view of the same connection follows a change made in the first', async () => {
		const r = await rig();
		const other = mountFrame(r.h, `write:${r.key}`);
		await until(() => other.frame.guard.first() !== null, 'the second frame learnt its account');
		const style = other.frame.env(true).userData.style(r.key);
		const off = style.subscribe(() => undefined);
		await r.frame.env(true).userData.editStyle(r.key, { kind: 'label', label: 'Person', style: { slot: 2 } });
		await until(() => style.get().labels.Person?.slot === 2, 'the second document saw the style');
		off();
		other.frame.dispose();
		r.dispose();
	});
});

describe('user data: colour slots are given once per new label, by the controller', () => {
	it('a loaded schema\'s labels get the lowest free slots in sorted order, written to the file; a later new label takes the next free one and moves nobody', async () => {
		let schema: Record<string, unknown> = NEO4J_SCHEMA;
		const r = await rig((call) => (call.tool === 'get_schema' || call.tool === 'refresh_schema' ? schema : readOnlyNode(call)));
		const style = r.frame.env(true).userData.style(r.key);
		const off = style.subscribe(() => undefined);
		await r.frame.env(true).loadSchema(r.key);
		const names = parseSchema(NEO4J_SCHEMA).labels.map((label) => label.name).sort();
		await until(() => Object.keys(style.get().assigned).length === 6, 'six labels given slots', 200);
		assert.deepEqual(style.get().assigned, Object.fromEntries(names.slice(0, 6).map((name, i) => [name, i])));
		await written(r.engine);
		// A new label that sorts first appears; nobody already given a slot moves, and every slot is held, so it hashes.
		const inner = schema.schema as Record<string, unknown>;
		schema = { ...schema, schema: { ...inner, labels: [{ name: 'Aardvark', properties: [], count: 1, count_estimated: false }, ...(inner.labels as unknown[])] } };
		await r.frame.env(true).loadSchema(r.key, { fresh: true });
		await until(() => r.controller.stores.schemas.get(r.key).view.labels.some((label) => label.name === 'Aardvark'), 'the new label loaded', 200);
		await settle();
		assert.deepEqual(style.get().assigned, Object.fromEntries(names.slice(0, 6).map((name, i) => [name, i])), 'no slot moved');
		off();
		r.dispose();
	});
});

describe('T7 - user data: nothing of one account is served to, kept for, or written for another', () => {
	it('a frame bound to A is refused once B is signed in, reading or saving; no owner is refused too', async () => {
		const r = await rig();
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.change(FP_A, saveOf('A after B')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.read(null), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		r.dispose();
	});

	it('A saves, then B signs in directly: A\'s save is never written into B\'s bag, and B is never served it', async () => {
		const r = await rig();
		await r.change(FP_A, saveOf('A only'));
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		const answer = await r.read('u2|org-1|team-1');
		assert.deepEqual(answer.saved.queries, [], 'B is served nothing of A');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify(bagOf(r.engine.files, 'u2|org-1|team-1') ?? {}).includes('A only'), false, 'nothing of A in B\'s bag');
		assert.equal(JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A only'), false, 'and A\'s pending write was dropped, not written later under B');
		r.dispose();
	});

	it('A saves, signs out, and signs in again with the sidebar open: written for A, and only for A', async () => {
		const r = await rig();
		await r.change(FP_A, saveOf('A again'));
		r.engine.realm.root.disconnect();
		await until(() => !r.controller.identity.get().known, 'nobody signed in');
		await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable', 'nothing is served while nobody is signed in');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A again'), false, 'the premise: held while nobody is signed in');
		r.engine.realm.root.connect(account('u1'));
		await until(() => JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A again'), 'A\'s save written for A', 200);
		r.dispose();
	});

	it('a save that waits for the file while the account changes is refused after the wait and never reaches B\'s file', async () => {
		const engine = vscodeRealm();
		let hold = true;
		const releases: Array<() => void> = [];
		const inner = engine.cm.request.bind(engine.cm);
		const cm = Object.assign(Object.create(null), engine.cm, {
			request: async (op: string, params: unknown, opts?: { timeoutMs?: number }) => {
				if (hold && (params as { path?: string } | null)?.path === USER_DATA_PATH && (op === 'client.fsStat' || op === 'client.fsReadJson')) await new Promise<void>((resolve) => releases.push(resolve));
				return inner(op, params, opts);
			},
		});
		signInVsCode(engine.realm);
		const mounted = mountController(cm as never);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.env(true).endpoints.get().endpoints.length === 1, 'discovery');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await until(() => releases.length > 0, 'A\'s file read held');
		const pending = frame.caller.callReply(OP.userDataEdit, { key, owner: FP_A, change: saveOf('Mid-switch') }, { timeoutMs: frameTimeoutFor(OP.userDataEdit) });
		await settle();
		engine.realm.root.accountChanged(account('u2'));
		await until(() => mounted.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		hold = false;
		for (const release of releases.splice(0)) release();
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify([...engine.files.values()]).includes('Mid-switch'), false, 'written nowhere');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('an account change clears the frame\'s view of the styles and saved queries, and its schema view', async () => {
		const r = await rig();
		const view = r.landing.env(true).userData.saved(r.key);
		const off = view.subscribe(() => undefined);
		await r.change(FP_A, saveOf('A only'));
		await until(() => view.get().queries.length === 1, 'the landing read A\'s');
		await r.landing.env(true).loadSchema(r.key);
		const offView = r.landing.schemaView.subscribe(() => undefined);
		r.landing.schemaView.get(r.key);
		await until(() => r.landing.schemaView.get(r.key) !== null, 'the landing read the schema view');
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.landing.lastReset() === 'identity', 'the landing reset');
		assert.deepEqual(view.get().queries, [], 'nothing of A is shown');
		assert.equal(r.landing.schemaView.get(r.key), null, 'nor A\'s schema');
		off();
		offView();
		r.dispose();
	});
});

describe('the schema view in a frame: read on first use, and again when a newer load completed', () => {
	it('null until the controller loaded it; the view after; read again after a refresh', async () => {
		let reads = 0;
		const r = await rig((call) => {
			if (call.tool === 'get_schema' || call.tool === 'refresh_schema') reads += 1;
			return readOnlyNode(call);
		});
		const views = r.engine.requests.length;
		const off = r.frame.env(true).schemaView.subscribe(() => undefined);
		assert.equal(r.frame.env(true).schemaView.get(r.key), null, 'nothing read yet');
		await settle();
		assert.equal(r.frame.env(true).schemaView.get(r.key), null, 'the controller has not loaded it either');
		await r.frame.env(true).loadSchema(r.key);
		await until(() => r.frame.env(true).schemaView.get(r.key) !== null, 'the view after the load');
		assert.deepEqual(r.frame.env(true).schemaView.get(r.key), JSON.parse(JSON.stringify(parseSchema(NEO4J_SCHEMA))));
		const first = r.frame.env(true).schemaView.get(r.key);
		assert.equal(r.frame.env(true).schemaView.get(r.key), first, 'stable between changes');
		const loadedAt = r.frame.schemas.get()[r.key].loadedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await r.frame.env(true).loadSchema(r.key, { fresh: true });
		await until(() => r.frame.schemas.get()[r.key].loadedAt !== loadedAt, 'the refresh completed');
		await until(() => r.frame.env(true).schemaView.get(r.key) !== first, 'the view read again');
		assert.ok(reads >= 2, 'the premise: two loads');
		assert.ok(r.engine.requests.length >= views, 'the reads are op results, not engine calls');
		off();
		r.dispose();
	});
});

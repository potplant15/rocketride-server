// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL FRAMES: the REMOTE env, the console and document frames' wiring
// across realms, identity close-out and host:connection (T2, T3, T7, T8, R8,
// R9, R11) over the REAL shell modules, as plain functions (R15)
// =============================================================================

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { codedError } from 'shared/explorer/connect/testing';
import { SUMMON_EVENT, SUMMON_GRACE_MS, SUMMON_SETTLE_MS } from 'shared/explorer/devtool/summon';
import { createDevToolHarness } from 'shared/explorer/devtool/testing';
import { callVector, fetchChunks, fetchDocument, fetchStats, scoreChunks } from '../src/adapters/actions';
import { vectorEndpoints } from '../src/adapters/explorer';
import type { IConnectionEntry } from '../src/adapters/connections';
import { remoteChannel } from '../src/devtool/frame';
import { CONTROLLER_NOT_READY_TEXT } from '../src/devtool/frameText';
import { OP, STATE, VECTOR_APP_ID } from '../src/devtool/protocol';
import type { IDocVersion, IQueryHint } from '../src/devtool/protocol';
import { DEVTOOL_CHAT_NOTE, DEVTOOL_UPLOADS_NOTE, NO_CHANNELS } from '../src/env';
import { buildConsoleModel } from '../src/vector/consoleModel';
import { consoleUri, documentUri } from '../src/vector/addresses';
import { DEFAULT_LIMITS, readDialect } from '../src/vector/results';
import { fixture } from './support/fixtures';
import { account, disposeAll, latestStateMap, mountController, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import { mountFrame } from './support/devtoolFrame';
import type { ToolBehaviour } from './support/vectorWorld';

afterEach(disposeAll);

const ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';

/** A signed-in VS Code realm, its controller and one frame of `docKey`, with discovery and the probe seen by the frame. */
async function connected(docKey: string | ((key: string) => string) | undefined, over: Partial<Record<string, ToolBehaviour>> = {}) {
	const engine = vscodeRealm(over);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm);
	mounted.h.setHostConnection(true);
	await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'discovery and the probe');
	const key = mounted.controller.store.getState().endpoints[0].key;
	const resolved = typeof docKey === 'function' ? docKey(key) : docKey;
	const framed = mountFrame(mounted.h, resolved, { hintDelayMs: 0 });
	await until(() => framed.frame.endpoints.get().endpoints.length === 1 && Object.keys(framed.frame.endpoints.get().probes).length === 1 && framed.frame.controllerReady.get(), 'the frame to see the connection');
	const endpoint = framed.frame.endpoints.get().endpoints[0];
	return { engine, mounted, ...mounted, ...framed, key, endpoint };
}

/** One connection's objects in a frame, as its view would make them. */
function entryOf(run: Awaited<ReturnType<typeof connected>>): IConnectionEntry {
	const probe = run.frame.endpoints.get().probes[run.key];
	const limits = (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS;
	return run.frame.env(true).connection(run.endpoint, limits);
}

describe('T3 / T2 - a frame\'s REMOTE env calls every tool through the controller, holding no client', () => {
	it('the console controller of a frame reads the store through ops: stats, the listing, the chunks; the engine call is the controller realm\'s', async () => {
		const run = await connected((key) => consoleUri(key));
		// The store singleton of the full app is never touched by a frame.
		const real = { session: vectorEndpoints.session, probe: vectorEndpoints.probe, refresh: vectorEndpoints.refresh, channel: vectorEndpoints.channel };
		const touched: string[] = [];
		vectorEndpoints.session = () => { touched.push('session'); throw new Error('the app store'); };
		vectorEndpoints.probe = async () => { touched.push('probe'); return null; };
		vectorEndpoints.refresh = async () => { touched.push('refresh'); };
		vectorEndpoints.channel = () => { touched.push('channel'); throw new Error('the app store'); };
		try {
			const entry = entryOf(run);
			const before = run.engine.requests.length;
			entry.controller.open();
			await until(() => entry.controller.getState().stats.status === 'ready' && entry.controller.getState().directory.rows.length > 0, 'stats and the first page');
			entry.selection.selectDocument({ objectId: 'doc-1', path: 'a.md' });
			entry.controller.selectDocument('doc-1');
			await until(() => entry.controller.getState().chunks.status === 'ready', 'the chunks');
			const tools = run.engine.requests.slice(before).filter((r) => r.op === 'client.tool').map((r) => (r.params as { tool: string }).tool);
			assert.ok(tools.includes('stats') && tools.includes('list_documents') && tools.includes('chunks'), tools.join(', '));
			assert.deepEqual(touched, [], 'nothing in the frame reached the full app\'s store');
			entry.controller.dispose();
		} finally {
			Object.assign(vectorEndpoints, real);
		}
		assert.deepEqual(run.h.violations, []);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a failure envelope is unwrapped in the frame with its code; a raised failure is an equal ExplorerToolError; a stale ticket drops the answer', async () => {
		const run = await connected((key) => consoleUri(key), { chunks: () => fixture('chunks_in_trash'), stats: () => Promise.reject(codedError('Task is stopping', 'TASK_STOPPED')) });
		const caller = run.frame.env(true).session(run.endpoint);
		assert.ok(caller, 'a ready frame has a caller');
		await assert.rejects(fetchChunks(caller, run.endpoint.nodeId, { objectId: 'doc-1', afterChunk: -1, limit: 100 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'store' && error.code === 'IN_TRASH');
		await assert.rejects(fetchStats(caller, run.endpoint.nodeId, 'full'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'raised' && error.code === 'TASK_STOPPED' && error.tool === 'stats' && error.message === 'Task is stopping');
		let current = true;
		const pending = callVector(caller, run.endpoint.nodeId, 'list_documents', { cursor: null, limit: 10 }, { generation: { isCurrent: () => current } as never });
		current = false;
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(caller.invoke('stats', { mode: 'full' }, { nodeId: 'store_2' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', 'a frame cannot aim a call at another node');
		await assert.rejects(caller.invoke('upsert', {}, { nodeId: run.endpoint.nodeId }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade', 'a tool the protocol does not carry');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the heat strip scores over the remote channel (embed on the embedding node, then neighbors); fetchDocument reads one row', async () => {
		const run = await connected((key) => documentUri(key, ID), { neighbors: () => fixture('neighbors_scope_scores') });
		const channels = run.frame.env(true).channels(run.endpoint);
		assert.ok(channels.tools, 'the remote tools channel');
		assert.equal(channels.chat, null, 'no chat in a dev-tool mount');
		assert.equal(channels.ingest, null, 'no uploads either');
		assert.equal(run.frame.env(true).channels(run.endpoint).tools, channels.tools, 'stable per connection');
		const scores = await scoreChunks({ caller: channels.tools, nodeId: 'store_1' }, { caller: channels.tools, nodeId: 'embed_1' }, [[ID, 0], [ID, 1]], 'where does the water come from?');
		assert.ok(Array.isArray(scores));
		const embed = run.engine.world.calls.filter((c) => c.tool === 'embed');
		assert.equal(embed.at(-1)?.nodeId, 'embed_1');
		const row = await fetchDocument(channels.tools, 'store_1', ID);
		assert.ok(row === null || typeof row.objectId === 'string');
		await assert.rejects(channels.tools.ask({}), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade' && error.message === DEVTOOL_CHAT_NOTE);
		await assert.rejects(channels.tools.sendFiles([]), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade' && error.message === DEVTOOL_UPLOADS_NOTE);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the frame env is REMOTE: the console model loses chat and uploads with the notes; documents open through the host', async () => {
		const run = await connected((key) => consoleUri(key));
		const env = run.frame.env(true);
		assert.equal(env.kind, 'remote');
		assert.ok(env.degraded);
		const model = env.consoleModel(buildConsoleModel(run.endpoint, run.frame.endpoints.get().probes[run.key], null));
		assert.deepEqual(model.chat, { enabled: false, reason: DEVTOOL_CHAT_NOTE });
		assert.deepEqual(model.ingest, { enabled: false, reason: DEVTOOL_UPLOADS_NOTE });
		env.openConsole(run.endpoint);
		env.openDocument(run.endpoint, ID, 'docs/water.md', 7);
		assert.deepEqual(run.docs.opened, [{ key: consoleUri(run.key), title: 'Store' }, { key: documentUri(run.key, ID), title: 'water.md' }]);
		await until(() => (latestStateMap(run.h)[STATE.focusRequests]?.snapshot as Record<string, { chunkId: number }> | undefined)?.[run.key]?.chunkId === 7, 'the focus request');
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('the console frame: hints out, other frames\' writes and map requests in', () => {
	it('its query and median reach the controller as hints, and are sent again to a controller that remounted without them', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		entry.selection.setQuery('where does the water come from?');
		await until(() => (latestStateMap(run.h)[STATE.queries]?.snapshot as Record<string, IQueryHint> | undefined)?.[run.key]?.text === 'where does the water come from?', 'the query hint');
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		await until(() => typeof (latestStateMap(run.h)[STATE.consoleSummary]?.snapshot as Record<string, { medianChunks: number | null }> | undefined)?.[run.key]?.medianChunks === 'number', 'the median hint');

		// The controller remounts (a VS Code reconnect): it starts without the hints, and the console sends them again,
		// once (the retained map still shows the old controller's topics until the new one publishes, so the signals
		// on the wire are counted, and the map is read once everything settled).
		const signals = (name: string): number => run.h.wire.filter((e) => e.transient && e.topic === `tool:${VECTOR_APP_ID}:toSidebar` && (e.value as { name?: unknown } | null)?.name === name).length;
		assert.equal(signals('queryChanged'), 1, 'the premise: one hint so far');
		run.controller.dispose();
		const again = mountController(run.engine.cm, {}, run.h, run.mounted);
		await until(() => signals('queryChanged') === 2, 'the hint again, for the new controller');
		for (let i = 0; i < 4; i += 1) await settle();
		assert.equal(signals('queryChanged'), 2, 'once per controller, never a loop');
		assert.equal((latestStateMap(run.h)[STATE.queries]?.snapshot as Record<string, IQueryHint> | undefined)?.[run.key]?.text, 'where does the water come from?', 'the new controller holds it');
		unbind();
		entry.controller.dispose();
		run.frame.dispose();
		again.controller.dispose();
	});

	it('another frame\'s write makes it relist, refresh its figures, probe again, redraw the map and forget what left; its own write does not', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		entry.selection.selectDocument({ objectId: ID, path: 'a.md' });
		const writesBefore = entry.writes.get();

		// Another frame (a document frame) moves a document to the trash.
		const other = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => other.frame.controllerReady.get(), 'the other frame');
		const before = run.engine.requests.length;
		await other.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: other.frame.origin }, { timeoutMs: 30_000 });
		await until(() => entry.writes.get() === writesBefore + 1, 'the map to be told to draw again');
		await until(() => run.engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'the relist');
		const tools = run.engine.requests.slice(before).map((r) => (r.params as { tool?: string }).tool);
		assert.ok(tools.includes('stats') && tools.includes('dialect'), `full figures and a probe (${tools.join(', ')})`);
		assert.equal(entry.selection.getState().document, null, 'the trashed document is forgotten');

		// Its own write: the controller already relists (consoleStore); the bump with its origin changes nothing more.
		const own = entry.writes.get();
		entry.controller.setWritesEnabled(true);
		entry.controller.requestRemove([{ objectId: ID, path: 'a.md', chunks: 12 }]);
		assert.ok(entry.controller.getState().confirm, 'a confirmation, nothing sent');
		await entry.controller.confirmRemove();
		await until(() => (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key]?.origin === run.frame.origin, 'its own bump');
		await settle();
		assert.equal(entry.writes.get(), own + 1, 'one redraw: the controller\'s own (onWritten), none for its own bump');
		unbind();
		entry.controller.dispose();
		other.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a map request (from a document frame) lands on its map once: highlight and the Map tab; a console mounted later finds nothing', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		const doc = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => doc.frame.endpoints.get().endpoints.length === 1 && doc.frame.controllerReady.get(), 'the document frame');
		const docEntry = doc.frame.env(true).connection(doc.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const actions = doc.frame.documentActions(docEntry);
		actions.showOnMap([[ID, 0], [ID, 1]], 'document');
		assert.deepEqual(doc.docs.opened.map((o) => o.key), [consoleUri(run.key)], 'the console is opened (or fronted)');
		await until(() => entry.tab.get() === 'map', 'the console to switch to its map');
		assert.deepEqual(entry.selection.getState().highlight, { source: 'document', keys: [[ID, 0], [ID, 1]] });
		await until(() => (latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, unknown> | undefined)?.[run.key] === undefined, 'taken, so the controller ends it');
		const later = mountFrame(run.h, consoleUri(run.key), { hintDelayMs: 0 });
		await until(() => later.frame.endpoints.get().endpoints.length === 1, 'a later console');
		const laterEntry = later.frame.env(true).connection(later.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const unbindLater = later.frame.bindConsole(laterEntry);
		await settle();
		assert.equal(laterEntry.tab.get(), 'console', 'nothing to take');
		unbindLater();
		unbind();
		for (const f of [later, doc, run]) f.frame.dispose();
		run.controller.dispose();
	});

	it('a document frame caps a map request at the node\'s project_keys_max and says so', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const said: string[] = [];
		const actions = run.frame.documentActions(entry, (text) => said.push(text));
		actions.showOnMap(Array.from({ length: 250 }, (_, i) => [ID, i] as const), 'document');
		await until(() => Boolean((latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, { keys: unknown[] }> | undefined)?.[run.key]), 'the map request');
		assert.equal((latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, { keys: unknown[] }>)[run.key].keys.length, 200);
		assert.ok(said.some((s) => /first 200/.test(s)), said.join(' / '));
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('the document frame: its focus, the console\'s query and median, and writes from anywhere', () => {
	it('a chunk focus for its document is taken once; one for another document is not; the console\'s query becomes its own', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const focused: number[] = [];
		const versions: IDocVersion[] = [];
		const unbind = run.frame.bindDocument(entry, ID, { focus: (chunkId) => focused.push(chunkId), version: (v) => versions.push(v) });
		const console = mountFrame(run.h, consoleUri(run.key), { hintDelayMs: 0 });
		await until(() => console.frame.endpoints.get().endpoints.length === 1 && console.frame.controllerReady.get(), 'the console frame');
		const consoleEntry = console.frame.env(true).connection(console.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const unbindConsole = console.frame.bindConsole(consoleEntry);
		console.frame.env(true).openDocument(run.endpoint, ID, 'a.md', 3);
		await until(() => focused.length === 1, 'the focus');
		assert.deepEqual(focused, [3]);
		assert.deepEqual(entry.selection.getState().chunk, [ID, 3]);
		console.frame.env(true).openDocument(run.endpoint, 'another-doc', 'b.md', 5);
		await settle();
		await settle();
		assert.deepEqual(focused, [3], 'a focus for another document is not taken');
		consoleEntry.selection.setQuery('radio check-in');
		await until(() => entry.selection.getState().query === 'radio check-in', 'the console\'s query, for the heat strip');
		assert.equal(run.frame.summaries.get()[run.key]?.medianChunks, undefined, 'no summary until the console listed');

		// A write from the console reaches the document frame as a version to read again.
		await console.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: console.frame.origin }, { timeoutMs: 30_000 });
		await until(() => versions.length === 1, 'the version');
		assert.equal(versions[0].action, 'trash');
		assert.deepEqual(versions[0].gone, [ID]);
		unbindConsole();
		unbind();
		console.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('its own Move to trash goes through its own controller (an inline confirmation, then one op) and is a version it reads again too', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const versions: IDocVersion[] = [];
		const unbind = run.frame.bindDocument(entry, ID, { focus: () => undefined, version: (v) => versions.push(v) });
		entry.controller.setWritesEnabled(true);
		const actions = run.frame.documentActions(entry);
		actions.requestRemove([ID]);
		assert.equal(entry.controller.getState().confirm?.action, 'trash', 'the confirmation is the frame\'s own');
		assert.ok(!run.engine.world.calls.some((c) => c.tool === 'soft_delete'), 'nothing sent before Confirm');
		const before = run.engine.requests.length;
		await entry.controller.confirmRemove();
		assert.equal(run.engine.world.calls.filter((c) => c.tool === 'soft_delete').length, 1);
		await until(() => versions.length === 1, 'its own version');
		await settle();
		assert.ok(!run.engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'a document frame never lists the directory');
		unbind();
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('T7 - identity fails closed in every frame', () => {
	it('VS Code: account A -> disconnect -> reconnect -> account B closes the console and document frames and clears their caches; the landing only resets', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'discovery');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const consoleFrame = mountFrame(mounted.h, consoleUri(key));
		const docFrame = mountFrame(mounted.h, documentUri(key, ID));
		const landing = mountFrame(mounted.h, undefined);
		await until(() => [consoleFrame, docFrame, landing].every((f) => f.frame.guard.first() !== null), 'the frames to learn account A');
		const entry = consoleFrame.frame.env(true).connection(consoleFrame.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		assert.equal(consoleFrame.frame.connections.count(), 1);

		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		assert.deepEqual(consoleFrame.docs.closed, [], 'a drop alone closes nothing');
		mounted.h.setHostConnection(true);
		engine.realm.root.connect(account('u2'));
		await until(() => consoleFrame.docs.closed.length > 0 && docFrame.docs.closed.length > 0, 'the documents to close for account B');
		assert.deepEqual(consoleFrame.docs.closed, [consoleUri(key)]);
		assert.deepEqual(docFrame.docs.closed, [documentUri(key, ID)]);
		assert.equal(consoleFrame.frame.lastReset(), 'identity');
		assert.equal(consoleFrame.frame.connections.count(), 0, 'its connection objects are gone');
		assert.equal(entry.selection.getState().connectionKey, null, 'and their selection reset');
		assert.deepEqual(landing.docs.closed, [], 'the landing is never closed');
		assert.equal(landing.frame.lastReset(), 'identity');
		for (const f of [consoleFrame, docFrame, landing]) f.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T8 - host:connection false: frames send nothing and drop what they wait for', () => {
	it('pending calls reject, new calls are refused before sending, the env is not ready, has no caller, and the console says it is offline', async () => {
		let release: (() => void) | null = null;
		const run = await connected((key) => consoleUri(key), { sample: () => new Promise((resolve) => { release = () => resolve(fixture('sample_demo_1000')); }) });
		const caller = run.frame.env(true).session(run.endpoint);
		assert.ok(caller);
		const running = caller.invoke('sample', { n: 1000 }, { nodeId: run.endpoint.nodeId });
		await until(() => release !== null, 'the sample to reach the node');
		run.h.setHostConnection(false);
		await assert.rejects(running, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /may still have run/.test(error.message));
		await settle();
		assert.equal(run.frame.connected.get(), false);
		const env = run.frame.env(run.frame.connected.get() === true);
		assert.equal(env.ready, false, 'nothing may be sent');
		assert.equal(env.session(run.endpoint), null);
		assert.deepEqual(env.channels(run.endpoint), NO_CHANNELS);
		assert.equal(run.frame.lastReset(), 'disconnected', 'the frame cleared its caches');
		const posted = run.h.wire.length;
		await assert.rejects(run.frame.caller.callReply(OP.probe, { key: run.key }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(run.h.wire.length, posted, 'refused before anything was posted');
		const entry = env.connection(run.endpoint, DEFAULT_LIMITS);
		entry.controller.refresh();
		await settle();
		assert.match(entry.controller.getState().stats.error?.headline ?? '', /Not connected to the server/, 'a console call made offline says so');
		(release as unknown as () => void)();
		assert.equal(run.controller.env(false).ready, false, 'the sidebar follows the realm\'s isConnected');
		assert.equal(run.controller.env(false).session(run.endpoint), null);
		entry.controller.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('F11/F12 - a frame summons a missing controller on purpose, and follows the sign-in', () => {
	it('one reserved, non-op summon event after the settle; "unanswered" only after the grace; a call never sent says to open the sidebar', async () => {
		const h = createDevToolHarness(VECTOR_APP_ID, { json: true });
		h.setHostConnection(true);
		const { frame, timers } = mountFrame(h, consoleUri('k1|a'));
		const signalled = (name: string): number => h.wire.filter((e) => e.transient && e.topic === `tool:${VECTOR_APP_ID}:toSidebar` && (e.value as { name?: unknown } | null)?.name === name).length;
		await settle();
		assert.equal(frame.summon.get(), 'summoning');
		assert.equal(signalled(SUMMON_EVENT), 0);
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(signalled(SUMMON_EVENT), 1, 'the summon event, not a call and not an op name');
		assert.deepEqual(h.emitted.filter((e) => e.op === 'host.mountToolSidebar'), [{ op: 'host.mountToolSidebar', params: { appId: VECTOR_APP_ID } }]);
		timers.advance(SUMMON_GRACE_MS);
		assert.equal(frame.summon.get(), 'unanswered');
		assert.equal(frame.signIn.get(), 'pending', 'no controller has said anything about the account');
		frame.dispose();
	});

	it('a call the base caller never sent (no controller became ready) reads as "open the sidebar" and as unavailable; one that was sent keeps its own failure', async () => {
		const h = createDevToolHarness(VECTOR_APP_ID, { json: true });
		h.setHostConnection(true);
		const { frame } = mountFrame(h, consoleUri('k1|a'));
		await until(() => frame.connected.get() === true, 'the host connection');
		const notSent = await frame.caller.callReply(OP.probe, { key: 'k1|a' }, { timeoutMs: 30 }).then(() => null, (error: unknown) => error);
		assert.ok(notSent instanceof ExplorerToolError && / was not sent: /.test(notSent.message), `the premise: the base's own failure (${String((notSent as Error)?.message)})`);
		const endpoint = { key: 'k1|a', nodeId: 'store_1', components: [], roles: {} } as never;
		const noController = remoteChannel({ callReply: () => Promise.reject(notSent), controllerReady: () => false } as never, endpoint, () => null, 'f');
		await assert.rejects(noController.invoke('stats', { mode: 'full' }, { nodeId: 'store_1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.message === CONTROLLER_NOT_READY_TEXT && error.tool === 'stats', 'never sent, so it cannot have run');
		const lost = new ExplorerToolError({ kind: 'timeout', tool: 'vector.trash', message: "Lost the connection while 'vector.trash' was running. It may still have run; there is no way to cancel it from here." });
		const sent = remoteChannel({ callReply: () => Promise.reject(lost), controllerReady: () => false } as never, endpoint, () => null, 'f');
		await assert.rejects(sent.invoke('soft_delete', { object_ids: ['x'] }, { nodeId: 'store_1' }), (error: unknown) => error === lost, 'a write that was sent keeps "may still have run"');
		frame.dispose();
	});
});

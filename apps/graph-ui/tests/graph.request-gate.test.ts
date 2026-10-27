// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// REQUEST GATE: one request at a time per workbench, across its tabs
// =============================================================================
//
// Apache AGE's node has a pool of four database connections, and a request the
// user stopped waiting for keeps one until the database finishes it. So a
// workbench sends one request at a time across all its tabs, counted until the
// call SETTLES (not until Stop waiting), and refuses the next with a sentence.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { GATE_BUSY_TEXT, createRequestGate } from '../src/graph/requestGate';

/** A call that settles when told to. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test('the gate is free until a request is sent, and busy until it settles', async () => {
	const gate = createRequestGate();
	assert.equal(gate.busy(), null);
	const call = deferred<number>();
	const sent = gate.send('read_query', () => call.promise);
	assert.equal(gate.busy(), GATE_BUSY_TEXT);
	call.resolve(7);
	assert.equal(await sent, 7);
	assert.equal(gate.busy(), null);
});

test('a second request while one is in flight is refused before it is sent, as a "not sent" tool error', async () => {
	const gate = createRequestGate();
	const first = deferred<string>();
	void gate.send('read_query', () => first.promise);
	let sent = false;
	await assert.rejects(
		gate.send('execute', async () => {
			sent = true;
			return 'x';
		}),
		(error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.tool === 'execute' && error.message === GATE_BUSY_TEXT
	);
	assert.equal(sent, false, 'nothing was sent');
	first.resolve('done');
});

test('a request that fails frees the gate too, and its error reaches the caller unchanged', async () => {
	const gate = createRequestGate();
	const boom = new Error('boom');
	await assert.rejects(gate.send('read_query', () => Promise.reject(boom)), (error: unknown) => error === boom);
	assert.equal(gate.busy(), null);
});

test('a request the caller stopped waiting for still holds the gate until the database answers', async () => {
	const gate = createRequestGate();
	const slow = deferred<number>();
	// The runner drops the promise when the user stops waiting; the gate keeps counting it.
	void gate.send('read_query', () => slow.promise).catch(() => undefined);
	assert.notEqual(gate.busy(), null);
	slow.resolve(1);
	await slow.promise;
	await Promise.resolve();
	assert.equal(gate.busy(), null);
});

test('listeners hear when the gate becomes busy and free', async () => {
	const gate = createRequestGate();
	const heard: (string | null)[] = [];
	const stop = gate.subscribe(() => heard.push(gate.busy()));
	const call = deferred<number>();
	const sent = gate.send('read_query', () => call.promise);
	call.resolve(1);
	await sent;
	stop();
	assert.deepEqual(heard, [GATE_BUSY_TEXT, null]);
	assert.ok(GATE_BUSY_TEXT.startsWith('Not sent: '));
});

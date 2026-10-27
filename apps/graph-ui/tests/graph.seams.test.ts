// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SEAMS FOR THE REDESIGN: the session's selection and path members, the schema
// view a mount offers, and the stubs that answer "nothing yet"
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphSession } from '../src/graph/graphSession';
import type { IGraphSessionDeps } from '../src/graph/graphSession';
import { failurePosition } from '../src/graph/errorPosition';
import { parseSchema } from '../src/graph/schema';
import { createSchemaStore } from '../src/graph/schemaStore';
import type { ReadQueryResult } from '../src/graph/types';
import { schemaViewOf } from '../src/localEnv';
import { fixture, node, rel } from './support/builders';

const envelope = (rows: ReadQueryResult['rows']): ReadQueryResult => ({ columns: ['c0', 'c1', 'c2'], rows, row_limit: 1000, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0 });

/** A session over a node that answers nothing. */
function rig() {
	const said: string[] = [];
	const deps: IGraphSessionDeps = {
		engine: () => ({ dialect: 'neo4j', version: '5.26.31' }),
		invoke: async () => envelope([]),
		describe: (error) => ({ variant: 'error', headline: String(error), detail: '', verbatim: '', generic: false, hint: null, ignore: false }),
		announce: (text) => said.push(text),
		captionChoice: () => undefined,
	};
	const session = createGraphSession(deps);
	session.load(envelope([[node('a', ['P'], { name: 'A' }), node('b', ['P'], { name: 'B' }), rel('r1', 'T', 'a', 'b')]]));
	return { session, said };
}

test('a loaded session starts with no selected relationship and no path', () => {
	const { session } = rig();
	assert.equal(session.getState().selectedRelationship, null);
	assert.equal(session.getState().path, null);
});

test('select: `only` replaces the selection and inspects the node; `toggle` is toggleSelect', () => {
	const { session } = rig();
	session.select('a', 'toggle');
	session.select('b', 'toggle');
	assert.deepEqual([...session.getState().selected], ['a', 'b']);
	session.select('b', 'only');
	assert.deepEqual([...session.getState().selected], ['b']);
	assert.deepEqual(session.getState().inspect, { kind: 'node', id: 'b' });
	session.select('b', 'toggle');
	assert.equal(session.getState().selected.size, 0);
	session.select('gone', 'only');
	assert.equal(session.getState().selected.size, 0, 'a node that is not drawn is not selected');
});

test('selectRelationship inspects the relationship and selecting a node clears it; null clears it', () => {
	const { session } = rig();
	session.selectRelationship('r1');
	assert.equal(session.getState().selectedRelationship, 'r1');
	assert.deepEqual(session.getState().inspect, { kind: 'relationship', id: 'r1' });
	session.selectRelationship(null);
	assert.equal(session.getState().selectedRelationship, null);
	assert.equal(session.getState().inspect, null);
	session.selectRelationship('r1');
	session.select('a', 'only');
	assert.equal(session.getState().selectedRelationship, null);
});

test('the redesign members answer for real: expandByType sends for a drawn node, queryTextFor writes a query, clearPath with no path is a no-op', async () => {
	const { session, said } = rig();
	const before = session.getState();
	await session.expandByType('gone', 'T');
	assert.equal(session.getState().model, before.model, 'a node that is not drawn is not expanded');
	await session.expandByType('a', 'T');
	assert.match(said.at(-1) ?? '', /^A is no longer found/, 'the node answered nothing, so the id no longer finds it');
	assert.equal(session.queryTextFor({ kind: 'node', id: 'a' }), "MATCH (n) WHERE elementId(n) = 'a' OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25");
	const state = session.getState();
	session.clearPath();
	assert.equal(session.getState(), state);
	assert.equal(failurePosition('Invalid input (line 1, column 10 (offset: 9))', 'neo4j'), null);
});

test('schemaViewOf: null until a load completed, then the view; a failed first load is the empty unknown view, not null', async () => {
	const store = createSchemaStore(() => 5);
	assert.equal(schemaViewOf(store.get('k')), null, 'never loaded');
	const loading = store.load('k', async () => fixture('schema_v2'), () => ({ variant: 'error', headline: 'no', detail: '', verbatim: '', generic: false, hint: null, ignore: false }));
	assert.equal(schemaViewOf(store.get('k')), null, 'the first load is still running');
	await loading;
	assert.deepEqual(schemaViewOf(store.get('k')), parseSchema(fixture('schema_v2')));
	await store.load('bad', async () => Promise.reject(new Error('down')), () => ({ variant: 'error', headline: 'down', detail: '', verbatim: '', generic: false, hint: null, ignore: false }));
	assert.equal(schemaViewOf(store.get('bad'))?.evidence, 'unknown');
});

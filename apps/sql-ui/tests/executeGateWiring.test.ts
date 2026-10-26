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
// EXECUTE GATE WIRING — a schema-only node turns the statement controls off
// =============================================================================
//
// With the execute state `off`, every control that needs a statement is
// disabled with a stated reason: Run, Run all, Explain, New Query, Select top
// 100, Count rows, Open data, and the Data page shows a schema-only state.
// While the state is `unknown` (a probe still in flight) nothing is disabled.
// The views have no DOM harness here, so the wiring is checked in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_ONLY_REASON, executeGateReason, schemaOnlyExplanation } from '../src/executeGate';

const src = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');

/** The opening tag of the GatedButton whose label is `label` (the label sits on its own line or between tags). */
function tagBefore(source: string, label: string): string {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const found = new RegExp(`(>|\\n\\t+)${escaped}(\\s*<|\\n)`).exec(source);
	assert.ok(found, `${label}: label not found`);
	const open = source.lastIndexOf('<GatedButton', found.index);
	assert.ok(open >= 0, `${label}: no GatedButton before it`);
	const tag = source.slice(open, found.index);
	assert.ok(!tag.includes('</GatedButton') && !tag.includes('</Button'), `${label}: the nearest button is another control`);
	return tag;
}

describe('executeGateReason', () => {
	it('is null while unknown or on, so a probe in flight disables nothing', () => {
		assert.equal(executeGateReason('unknown'), null);
		assert.equal(executeGateReason('on'), null);
	});

	it('is the one stated reason when off', () => {
		assert.equal(executeGateReason('off'), SCHEMA_ONLY_REASON);
		assert.match(schemaOnlyExplanation('Shop reporting'), /Shop reporting node has allow_execute off/);
	});
});

describe('the gated button', () => {
	const button = src('components', 'GatedButton.tsx');

	it('carries aria-disabled, the reason as its description, and a disabled button inside', () => {
		assert.match(button, /aria-disabled="true"/);
		assert.match(button, /aria-describedby=\{reasonId\}/);
		assert.match(button, /<Button \{\.\.\.button\} disabled title=\{gateReason\}/);
	});
});

describe('every listed control takes the gate', () => {
	it('New Query', () => {
		assert.match(tagBefore(src('views', 'ConnectionView.tsx'), 'New Query'), /gateReason=\{gateReason\}/);
	});

	it('Run, Run all and Explain', () => {
		const query = src('views', 'QueryView.tsx');
		assert.match(tagBefore(query, 'Run all'), /gateReason=\{gateReason\}/);
		assert.match(tagBefore(query, "{running ? 'Running…' : 'Run'}"), /gateReason=\{gateReason\}/);
		assert.match(tagBefore(query, 'Explain'), /gateReason=\{gateReason\}/);
	});

	it('Select top 100, Count rows and Open data in the drawer', () => {
		const drawer = src('components', 'TableRecordPanel.tsx');
		assert.match(tagBefore(drawer, 'Select top 100'), /gateReason=\{gateReason\}/);
		assert.match(tagBefore(drawer, 'Count rows'), /gateReason=\{gateReason\}/);
		assert.match(tagBefore(drawer, 'Open data'), /gateReason=\{gateReason\}/);
	});

	it('the Data page shows a schema-only state in place of the grid', () => {
		const data = src('views', 'TableDataView.tsx');
		assert.match(data, /useExecuteState\(endpoint\.key\)/);
		assert.match(data, /executeGateReason\(executeState\)/);
		assert.match(data, /title="Schema only"/);
	});

	it('an Overview row click opens the drawer, not the data, when statements are off', () => {
		const overview = src('panels', 'OverviewPanel.tsx');
		assert.match(overview, /onRowClick=\{\(row\) => \(gateReason \? setStack\(\[row\.name\]\) : pageNav\.openTableData\(row\.name\)\)\}/);
	});
});

describe('the probe', () => {
	const store = src('schema', 'schemaStore.ts');
	const view = src('views', 'ConnectionView.tsx');

	it('is SELECT 1, idempotent, and never recorded in history', () => {
		assert.match(store, /session\.execute\('SELECT 1', \{ idempotent: true \}\)/);
		assert.ok(!/history/i.test(store.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'the store touches history');
	});

	it('is started once per open by the workbench, and can be run again', () => {
		assert.match(view, /probeExecute\(env\.getSession\(endpoint\)\)/);
		assert.match(view, /Check again/);
	});
});

describe('QueryView learns the state from what runs', () => {
	const query = src('views', 'QueryView.tsx');

	it('records a refusal and a statement that ran in the store', () => {
		assert.match(query, /noteExecuteFailure\(endpoint\.key, notice\.verbatim\)/);
		assert.match(query, /noteExecuteSuccess\(endpoint\.key\)/);
	});
});

describe('TableDataView learns the state from a failed page', () => {
	it('records the load failure', () => {
		assert.match(src('views', 'TableDataView.tsx'), /noteExecuteFailure\(endpoint\.key, error\.message/);
	});
});

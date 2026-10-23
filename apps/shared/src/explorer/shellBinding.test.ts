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
// EXPLORER — SHELL BINDING (what a task event asks the endpoint store to do)
// =============================================================================
//
// The engine announces a task's start (`begin`, `restart`) while the task is
// still loading, and discovery lists running tasks only, so the store must be
// told WHICH task started to keep looking for it. These cases pin how an
// `apaevt_task` message is read; the subscriptions themselves need the shell.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTaskEvent } from './shellBinding';

describe('readTaskEvent — an apaevt_task message as the store reads it', () => {
	it('ignores anything that is not an apaevt_task event', () => {
		assert.equal(readTaskEvent(null), null);
		assert.equal(readTaskEvent('apaevt_task'), null);
		assert.equal(readTaskEvent({ event: 'apaevt_status_update', body: { state: 3, project_id: 'p1', source: 'ingest_1' } }), null);
	});

	it('names the task a begin or a restart started, and asks a restart for a re-probe', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', name: 'x.ingest_1.Ingest', projectId: 'p1', source: 'ingest_1', beginSeq: 4 } }), { reprobe: false, started: { projectId: 'p1', source: 'ingest_1' } });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'restart', projectId: 'p1', source: 'tools_1' } }), { reprobe: true, started: { projectId: 'p1', source: 'tools_1' } });
	});

	it('names the task an end stopped', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'end', projectId: 'p1', source: 'ingest_1', reason: 'user' } }), { reprobe: false, ended: { projectId: 'p1', source: 'ingest_1' } });
	});

	it('reads the stamped project_id when projectId is absent, and names no task when the body cannot say which', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', project_id: 'p2', source: 'chat_1' } }), { reprobe: false, started: { projectId: 'p2', source: 'chat_1' } });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', source: 'ingest_1' } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', projectId: 'p1', source: '' } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'restart', projectId: 7, source: 'tools_1' } }), { reprobe: true });
	});

	it('only asks for a refresh on the running snapshot or a body it cannot read', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'running', tasks: [{ projectId: 'p1', source: 'tools_1' }] } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task' }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: 'begin' }), { reprobe: false });
	});
});

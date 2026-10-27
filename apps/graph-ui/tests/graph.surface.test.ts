// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// RUN SURFACE HELPERS: the editor request mailbox, and how a run settles in each mode
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entrySummary, historyEmptyText } from '../src/components/HistoryPanel';
import { createLoadSlot } from '../src/graph/loadSlot';
import { STILL_RUNNING_TEXT, affectedNotReported, historySummaryOf, limitPatch, runRefusal, settleRun, toHistoryEntry } from '../src/graph/runConfig';
import type { IResultSummary } from '../src/graph/results';
import type { GraphValue, ReadQueryResult } from '../src/graph/types';
import { AGE_AFFECTED_NOT_REPORTED, NOTICE_HEADLINE_MAX, resultMeta, resultNotes, splitNotice } from '../src/graph/wording';
import { node } from './support/builders';

// A request left for the editor is taken from the host's slot once. De-duplicating it with a ref that starts at 0 on
// every mount would replay it on any remount: the editor text and its saved draft overwritten, and a preview (or a
// History "Run again") run again by itself.
test('a request left for the editor is taken exactly once: a remount finds nothing to replay', () => {
	const slot = createLoadSlot();
	assert.equal(slot.take(), null, 'nothing before anything is put');
	const seq = slot.put({ text: 'MATCH (n:Person) RETURN n LIMIT 25', run: true });
	assert.equal(seq, 1);
	assert.deepEqual(slot.take(), { text: 'MATCH (n:Person) RETURN n LIMIT 25', run: true });
	assert.equal(slot.take(), null, 'a second mount takes nothing');
	assert.equal(slot.take(), null);
});

test('a newer request replaces one not yet taken, and every put has a new sequence number', () => {
	const slot = createLoadSlot();
	assert.equal(slot.put({ text: 'old', run: true }), 1);
	assert.equal(slot.put({ text: 'new', run: false }), 2);
	assert.deepEqual(slot.take(), { text: 'new', run: false });
	assert.equal(slot.take(), null);
	assert.equal(slot.put({ text: 'again', run: false }), 3);
	assert.deepEqual(slot.take(), { text: 'again', run: false });
});

// -----------------------------------------------------------------------------
// The write console reports what execute said, and no row limit it never sent
// -----------------------------------------------------------------------------

const answer = (rows: GraphValue[][], extra: Partial<ReadQueryResult> = {}): ReadQueryResult => ({ columns: rows[0]?.map((_, i) => `c${i}`) ?? [], rows, row_limit: 25000, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0, ...extra });

test('the write console settles a statement with the affected count execute returned, and keeps its rows for the graph', () => {
	const created = answer([], { affected_rows: 3 });
	assert.deepEqual(settleRun('write', created), { outcome: 'affected', rowCount: 0, affected: 3, result: created });
	const returned = answer([[node('n1', ['X'])]], { affected_rows: 1 });
	assert.deepEqual(settleRun('write', returned), { outcome: 'affected', rowCount: 1, affected: 1, result: returned });
	assert.deepEqual(settleRun('read', returned), { outcome: 'rows', rowCount: 1, result: returned }, 'a read is rows');
	assert.equal(settleRun('write', answer([])).outcome, 'rows', 'an answer without the count is not shown as "0 affected"');
});

// Apache AGE's node reports its result ROWS as `affected_rows` (0 for a write with no RETURN), not a count of changes.
test('on Apache AGE a write settles as the rows it returned, and the result line says the affected count is not reported', () => {
	const created = answer([], { affected_rows: 0 });
	assert.equal(affectedNotReported('write', 'age'), true);
	assert.equal(affectedNotReported('read', 'age'), false);
	assert.equal(affectedNotReported('write', 'neo4j'), false);
	assert.deepEqual(settleRun('write', created, 'age'), { outcome: 'rows', rowCount: 0, result: created });
	assert.equal(settleRun('write', created, 'neo4j').outcome, 'affected');
	assert.equal(resultMeta({ outcome: 'rows', ms: 400 }, created, true), `${AGE_AFFECTED_NOT_REPORTED} · 0 rows returned (limit 25,000) · 0.4 s round trip`);
	assert.equal(AGE_AFFECTED_NOT_REPORTED, 'Affected count not reported by Apache AGE');
	assert.doesNotMatch(resultMeta({ outcome: 'rows', ms: 400 }, created, true), /0 affected/);
	assert.equal(resultMeta({ outcome: 'rows', ms: 400 }, created), '0 rows returned (limit 25,000) · 0.4 s round trip', 'elsewhere nothing is added');
});

test('the write console records no row limit: execute takes none, so none was sent', () => {
	assert.deepEqual(limitPatch('write', 1000), { limitApplied: null });
	assert.deepEqual(limitPatch('read', 1000), { limitApplied: 1000, limitState: 'node' });
});

test('history keeps a write\'s affected count without a limit, and a read\'s rows with its limit', () => {
	const write = historySummaryOf({ cypher: 'CREATE (:X)', verb: 'CREATE', outcome: 'affected', affected: 1, ms: 12.4, limitApplied: null }, 1_000);
	assert.deepEqual(write, { cypher: 'CREATE (:X)', at: 988, ms: 12, outcome: 'affected', affected: 1, kind: 'CREATE' });
	assert.equal(entrySummary(toHistoryEntry(write, 'w')), '1 affected');
	const read = historySummaryOf({ cypher: 'MATCH (n) RETURN n', verb: 'MATCH', outcome: 'rows', result: answer([[1], [2]]), ms: 5, limitApplied: 1000 }, 1_000);
	assert.deepEqual(read, { cypher: 'MATCH (n) RETURN n', at: 995, ms: 5, outcome: 'rows', rows: 2, limit: 1000, kind: 'MATCH' });
	assert.equal(entrySummary(toHistoryEntry(read, 'r')), '2 rows (limit 1,000)');
	const failed = historySummaryOf({ cypher: 'X', verb: 'X', outcome: 'error', error: 'boom', ms: 1, limitApplied: null }, 1_000);
	assert.equal(failed.outcome, 'error');
	assert.equal(failed.error, 'boom');
	const unreported = historySummaryOf({ cypher: 'CREATE (:X)', verb: 'CREATE', outcome: 'affected', ms: 1, limitApplied: null }, 1_000);
	assert.equal('affected' in unreported, false, 'no count is invented');
	assert.equal(entrySummary(toHistoryEntry(unreported, 'u')), 'affected count not reported');
});

test('the result line of a write leads with the affected count', () => {
	assert.equal(resultMeta({ outcome: 'affected', affected: 3, ms: 400 }, answer([])), '3 affected · 0 rows returned (limit 25,000) · 0.4 s round trip');
	assert.equal(resultMeta({ outcome: 'rows', ms: 400 }, answer([[1]], { row_limit: 1000 })), '1 row returned (limit 1,000) · 0.4 s round trip');
});

// -----------------------------------------------------------------------------
// A run that cannot start says so
// -----------------------------------------------------------------------------

test('a run asked for while a statement is still running, or while the surface is paused, is refused with a sentence', () => {
	assert.equal(runRefusal({ running: false, blocked: null }), null);
	assert.equal(runRefusal({ running: true, blocked: null }), STILL_RUNNING_TEXT);
	assert.match(STILL_RUNNING_TEXT, /^Nothing was sent: a statement is still running\./);
	assert.equal(runRefusal({ running: true, blocked: 'Checking this connection again.' }), 'Nothing was sent. Checking this connection again.');
});

// -----------------------------------------------------------------------------
// An empty History list says why
// -----------------------------------------------------------------------------

test('History says "No entries match" when a search or Pinned only hides entries, not "No history yet"', () => {
	assert.equal(historyEmptyText(3, true).title, 'No entries match');
	assert.match(historyEmptyText(3, false).description, /Clear the search or turn off Pinned only/);
	assert.deepEqual(historyEmptyText(0, true), { title: 'No history yet', description: 'Statements you run on this connection appear here.' });
	assert.equal(historyEmptyText(0, false).title, 'Recording is off for this connection');
});

// -----------------------------------------------------------------------------
// The result's warnings are one "Notes (N)" line, each a headline with its details
// -----------------------------------------------------------------------------

const summaryWith = (over: Partial<IResultSummary>): IResultSummary => ({ rowCount: 1, columnCount: 1, nodeCount: 0, relationshipCount: 0, pathCount: 0, danglingRelationships: 0, drawable: false, scalarOnly: true, malformed: 0, unsafeNumbers: 0, ...over });

test('a result\'s warnings become notes: a short headline each, the full sentence in the details', () => {
	assert.deepEqual(resultNotes(summaryWith({})), []);
	const notes = resultNotes(summaryWith({ unsafeNumbers: 2, malformed: 1, danglingRelationships: 3 }));
	assert.deepEqual(notes.map((n) => n.id), ['unsafe-numbers', 'malformed', 'dangling']);
	assert.equal(notes[0].headline, '2 large integers may have been rounded');
	assert.match(notes[0].details, /^2 integer values beyond 2\^53 arrived as plain JSON numbers/);
	assert.equal(notes[1].headline, '1 malformed value shown as plain data');
	assert.equal(notes[2].headline, '3 relationships not drawn: an end node was not returned');
	assert.match(notes[2].details, /Return the nodes too, or expand a node\.$/);
	assert.equal(resultNotes(summaryWith({ danglingRelationships: 1 }))[0].headline, '1 relationship not drawn: an end node was not returned');
	for (const note of notes) assert.ok(note.headline.length <= NOTICE_HEADLINE_MAX, note.headline);
});

test('a long notice is split into its first sentence and the rest, for a headline with a Details disclosure', () => {
	assert.deepEqual(splitNotice('Not sent: statement 2 looks like it changes data (CREATE). Query tabs only run reads. This is a text check.'), { headline: 'Not sent: statement 2 looks like it changes data (CREATE).', details: 'Query tabs only run reads. This is a text check.' });
	assert.deepEqual(splitNotice('One sentence only.'), { headline: 'One sentence only.', details: '' });
	assert.deepEqual(splitNotice('Not sent (CALL db.labels). Then more.'), { headline: 'Not sent (CALL db.labels).', details: 'Then more.' }, 'a dot inside a name does not end the sentence');
});

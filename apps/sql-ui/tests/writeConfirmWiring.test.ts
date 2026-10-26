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
// WRITE CONFIRMATION WIRING — the query view asks by the connection's level
// =============================================================================
//
// The query view asks before a statement by the SAVED CONNECTION's safety
// level, through SQL's own dialog. The old per-connection pattern-check
// switch (a preference, session-only in a dev tool) and its "Run and stop
// asking" answer are gone: the level is changed in the connection's editor.
// The affected-row estimate is a plain EXPLAIN sent on the document's session,
// never through the runner, so it is never recorded in history. The view has
// no DOM harness here, so this reads the source, as the other wiring suites do.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const view = read('views/QueryView.tsx');
const dialog = read('components/WriteConfirmDialog.tsx');

/**
 * Every source file under src/, recursively.
 *
 * @param dir - The directory.
 * @returns Absolute paths.
 */
function sources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
	});
}

describe('QueryView asks by the connection\'s safety level', () => {
	it('reads the level off the saved connection record', () => {
		assert.match(view, /const \{ record: connectionRecord \} = useConnectionRecord\(endpoint\.connId \?\? null\);/);
		assert.match(view, /const safety = safetyLevelOf\(connectionRecord\);/);
	});

	it('hands the runner needsConfirmation at that level, and nothing that turns asking off', () => {
		assert.match(view, /patternChecksOn: \(\) => safety !== 'off',/);
		assert.match(view, /patternCheck: \(run\) => needsConfirmation\(run\.sql, dialect, safety\),/);
		assert.doesNotMatch(view, /disablePatternChecks/);
	});

	it('shows SQL\'s own dialog, not the shared one with its "stop asking" answer', () => {
		assert.doesNotMatch(view, /PatternConfirmDialog/);
		assert.match(view, /<WriteConfirmDialog[\s\S]*?confirmation=\{toWriteConfirmation\(patternPrompt\.finding\)\}[\s\S]*?onAnswer=\{answerPattern\}/);
	});

	it('retires the old switch: no preference key, no "Pattern checks off" control', () => {
		for (const gone of [/PATTERN_CHECK_PREF/, /sql\.patternChecks/, /Pattern checks off/, /setPatternChecks/, /patternChecksOnRef/]) {
			assert.doesNotMatch(view, gone);
		}
	});

	it('names the level on the line under the editor, so it is never invisible', () => {
		assert.match(view, /title="Safety level for this connection\. Change it in the connection's settings\."/);
		assert.match(view, /\{SAFETY_LINE\[safety\]\}/);
	});
});

describe('the affected-row estimate', () => {
	it('runs a plain EXPLAIN on the document\'s session while the dialog is open, repeatable, outside the runner', () => {
		assert.match(view, /const statement = rowEstimateStatement\(patternPrompt\.run\.sql, dialect\);/);
		assert.match(view, /env\.getSession\(endpoint\)\.execute\(statement, \{ idempotent: true, generation: ticket \}\)/);
		assert.match(view, /parseRowEstimate\(dialect, result\.rows \?\? \[\]\)/);
	});

	it('drops a late answer once the dialog closes', () => {
		assert.match(view, /return \(\) => \{\s*alive = false;\s*estimateGeneration\.invalidate\(\);\s*\};/);
	});
});

describe('the write dialog', () => {
	it('enables its confirm button only on an exact typed name, and never disables Cancel', () => {
		assert.match(dialog, /const matches = target === null \|\| confirmTextMatches\(typed, target\);/);
		assert.match(dialog, /confirmDisabled=\{!matches\}/);
		assert.match(dialog, /onConfirm=\{\(\) => \{ if \(matches\) onAnswer\('run'\); \}\}/);
		assert.match(dialog, /onCancel=\{\(\) => onAnswer\('cancel'\)\}/);
		assert.doesNotMatch(dialog, /secondaryLabel|onSecondary/);
	});

	it('takes the name in a plain input that neither autocompletes nor spellchecks, and does not block paste', () => {
		assert.match(dialog, /autoComplete="off"/);
		assert.match(dialog, /spellCheck=\{false\}/);
		assert.doesNotMatch(dialog, /onPaste/);
	});

	it('starts focus in the input for a typed name, otherwise on Cancel', () => {
		assert.match(dialog, /if \(inputRef\.current\) inputRef\.current\.focus\(\);\s*else focusCancelIn\(anchorRef\.current\);/);
	});
});

describe('no "stop asking" anywhere in SQL Explorer', () => {
	it('has no such text, and no \'always\' answer, in apps/sql-ui/src', () => {
		for (const file of sources(SRC)) {
			const text = fs.readFileSync(file, 'utf8');
			assert.doesNotMatch(text, /stop asking/i, path.relative(SRC, file));
		}
		assert.doesNotMatch(view + dialog, /'always'/);
	});

	it('keeps the history rerun confirmation for writes as it was', () => {
		const panel = read('components/HistoryPanel.tsx');
		assert.match(panel, /if \(changesData\(entry\)\) \{\s*setConfirmRerun\(entry\);/);
		assert.match(panel, /title="Run this again\?"/);
	});
});

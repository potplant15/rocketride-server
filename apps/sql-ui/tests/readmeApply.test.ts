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
// README CLAIMS — Apply (transactions) and Changing a table
// =============================================================================
//
// What the README says about Apply's transaction is what the code does: the
// budget, the dialects that get one, and the designer's notes. Kept beside
// readmeClaims.test.ts in its own file.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPLY_BUDGET_MS, NODE_TX_IDLE_MS } from '../src/connect/tools';
import { designApplyMode } from '../src/views/TableDesignView';
import { rowEditApplyMode } from '../src/components/ReviewSqlDialog';

const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

describe('README claims: Apply', () => {
	it('states the apply budget the session uses, and that it is the node\'s idle-transaction time', () => {
		assert.equal(APPLY_BUDGET_MS, 5 * 60_000);
		assert.equal(APPLY_BUDGET_MS, NODE_TX_IDLE_MS);
		assert.match(prose, /An apply's statements may take 5 minutes in all, the time the node keeps an idle transaction open\./);
	});

	it('names where there is no transaction, as the code decides', () => {
		assert.match(prose, /ClickHouse opens no transactions, and a node older than the transaction tools has none\./);
		assert.equal(rowEditApplyMode('clickhouse').atomic, false);
		assert.equal(rowEditApplyMode('postgres').atomic && rowEditApplyMode('mysql').atomic, true);
	});

	it('says the designer applies as one transaction on PostgreSQL only, and quotes the notes the code shows', () => {
		assert.equal(designApplyMode('postgres').atomic, true);
		assert.equal(designApplyMode('mysql').atomic || designApplyMode('clickhouse').atomic, false);
		// The README's bullet is labelled `**MySQL** —`; the sentence after the label is the code's.
		assert.ok(prose.includes((designApplyMode('mysql').note as string).replace(/^MySQL: /, '')));
		assert.match(prose, /The result says `The plan runs as one transaction: a failure rolls back the whole plan` only when the node confirms the plan ran as one\./);
		assert.doesNotMatch(prose, /each statement runs in its own autocommit transaction/, 'the old PostgreSQL note is gone');
		assert.doesNotMatch(prose, /SQL Explorer does not use it/);
	});
});

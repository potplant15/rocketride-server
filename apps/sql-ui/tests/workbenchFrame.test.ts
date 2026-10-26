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
// WORKBENCH FRAME — which pages show the workbench header, and the diagram's height
// =============================================================================
//
// Query, Data and Design carry their own header, so the workbench header above
// them made two stacked headers (and padding on padding). The diagram is
// React Flow, which needs a definite height: its root and every wrapper
// around its empty states must be `height: 100%` with `minHeight: 0`. The
// views have no DOM harness here, so the wiring is checked in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageHasOwnHeader, showsWorkbenchHeader } from '../src/pageFrame';

const src = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');

describe('which pages show the workbench header', () => {
	it('is Overview, Insights and Diagram only', () => {
		assert.deepEqual(['overview', 'insights', 'diagram'].filter(showsWorkbenchHeader), ['overview', 'insights', 'diagram']);
		for (const page of ['query', 'data', 'design']) assert.equal(showsWorkbenchHeader(page), false, page);
	});

	it('marks the pages that carry their own header, which the panel does not pad again', () => {
		for (const page of ['query', 'data', 'design']) assert.equal(pageHasOwnHeader(page), true, page);
		for (const page of ['overview', 'insights', 'diagram']) assert.equal(pageHasOwnHeader(page), false, page);
	});
});

describe('ConnectionView frame', () => {
	const view = src('views', 'ConnectionView.tsx');

	it('renders the workbench ContentHeader only through showsWorkbenchHeader', () => {
		assert.match(view, /showsWorkbenchHeader\(activePage\)\s*&&\s*\(\s*<ContentHeader/);
		assert.equal((view.match(/<ContentHeader/g) ?? []).length, 1);
	});

	it('takes the panel padding off the pages that pad themselves', () => {
		assert.match(view, /pageHasOwnHeader\(activePage\)\s*\?\s*styles\.panelsBare\s*:\s*styles\.panels/);
	});

	it('hands the diagram the way to open a table, rather than navigating inside it', () => {
		assert.match(view, /<DiagramView endpoint=\{endpoint\} onOpenTable=\{pageNav\.openTableData\}/);
	});
});

describe('the editor region', () => {
	it('gets more than the old 38% and room for about 13 lines', () => {
		const query = src('views', 'QueryView.tsx');
		const region = /editorRegion: \{([\s\S]*?)\}/.exec(query);
		assert.ok(region, 'editorRegion not found');
		const share = /flex: '0 0 (\d+)%'/.exec(region[1]!);
		assert.ok(share && Number(share[1]) > 38, 'the editor still gets 38% or less');
		const min = /minHeight: (\d+)/.exec(region[1]!);
		assert.ok(min && Number(min[1]) >= 250, 'the editor has no room for 13 lines');
	});
});

describe('the diagram', () => {
	const diagram = src('views', 'DiagramView.tsx');

	it('gives the root and the empty-state wrapper a definite height', () => {
		for (const name of ['root', 'emptyWrap']) {
			const block = new RegExp(`${name}: \\{([\\s\\S]*?)\\} as CSSProperties`).exec(diagram);
			assert.ok(block, `${name} style not found`);
			assert.match(block[1]!, /height: '100%'/, `${name} has no height`);
			assert.match(block[1]!, /minHeight: 0/, `${name} has no minHeight`);
		}
	});

	it('opens a table when its node is clicked, through the prop', () => {
		assert.match(diagram, /onNodeClick=\{/);
		assert.match(diagram, /onOpenTable\(/);
		assert.ok(!/useSqlPageNav/.test(diagram), 'the diagram must not call useSqlPageNav');
	});

	it('colours the minimap from the theme', () => {
		const mini = /<MiniMap[\s\S]*?\/>/.exec(diagram);
		assert.ok(mini, 'MiniMap not found');
		for (const prop of ['nodeColor', 'maskColor', 'bgColor']) {
			assert.match(mini[0], new RegExp(`${prop}="var\\(--rr-`), prop);
		}
	});

	it('says "Reading the schema" and "Could not read the schema"', () => {
		assert.match(diagram, /title="Reading the schema…"/);
		assert.match(diagram, /title="Could not read the schema"/);
		assert.ok(!/Reverse engineering/.test(diagram.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'old wording remains');
	});
});

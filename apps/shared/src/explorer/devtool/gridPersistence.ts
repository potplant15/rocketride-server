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
// EXPLORER DEV TOOL — GRID LAYOUTS IN A DEV-TOOL MOUNT (session only)
// =============================================================================
//
// A shell DataGrid with a `tableId` and no `persistence` prop persists its
// layout (Tabulator's sort, columns, page blobs) through the grid config
// channel, which the HOST answers from the active app's workspace prefs. In a
// dev-tool frame the active app is the host (Rocket Builder), so a store
// tool's grids would write into the host's own bag: store tools get no prefs
// of their own (§3.5), and this is the same leak `usePrefs` would be.
//
// It is also how Rocket Builder froze (#2625 9bd5d931f). The host answers a
// read with the stored blob by reference; Tabulator's sort module rewrites a
// persisted sorter list in place, swapping each field name for its live
// column object; so the host's prefs end up holding a Tabulator column (its
// table, DOM elements, functions). The next workspace save sends that object
// through the SDK's message redaction walk, which never finishes on it.
//
// So frames give their grids this persistence instead: one per realm, in
// memory, for the session. It stores and hands out COPIES (plain JSON), so
// nothing Tabulator does to what it read can reach what is stored, and a blob
// that is not plain JSON is not stored at all. Layouts survive tab switches
// and documents in the session, not a reload; the full app keeps its prefs.
// =============================================================================

import type { DataGridLayout, IDataGridPersistence } from 'shell';

/**
 * A plain-JSON copy of a value, or undefined when it has none (a cycle).
 *
 * @param value - The value.
 * @returns The copy.
 */
function jsonCopy(value: unknown): unknown {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * A DataGrid persistence for dev-tool frames: in memory for the session,
 * copies in and out (see the header).
 *
 * @returns The persistence; share one per realm.
 */
export function createSessionGridPersistence(): IDataGridPersistence {
	const layouts = new Map<string, DataGridLayout>();
	return {
		read(tableId, type) {
			const layout = layouts.get(tableId);
			if (!layout || !(type in layout)) return false;
			return jsonCopy(layout[type]) ?? false;
		},
		write(tableId, type, data) {
			const copy = jsonCopy(data);
			if (copy === undefined) return;
			layouts.set(tableId, { ...layouts.get(tableId), [type]: copy });
		},
		clear(tableId) {
			layouts.delete(tableId);
		},
	};
}

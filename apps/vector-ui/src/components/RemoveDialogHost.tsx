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
// VECTOR-UI — REMOVE DIALOG HOST (the confirmation of the active connection)
// =============================================================================
//
// Mounted once at the app root, outside every document pane, so a write
// asked for from the console, the map or a document tab is confirmed where
// the user can see it (a dialog inside a hidden pane would not be). It shows
// the pending confirmation of the ACTIVE connection's controller (Move to
// trash, Delete permanently or Empty trash, each with its own words and
// typed rules: vector/confirm.ts); Cancel and Confirm go back to that
// controller, which alone sends anything.
// =============================================================================

import React, { useSyncExternalStore } from 'react';
import { existingEntry } from '../adapters/connections';
import type { IConnectionEntry } from '../adapters/connections';
import { useActiveConnection } from '../adapters/react';
import { emptyTrashConfirmation, multiRemoveConfirmation, multiTrashConfirmation, removeConfirmation, trashConfirmation } from '../vector/confirm';
import type { IRemoveContext } from '../vector/confirm';
import { readDialect } from '../vector/results';
import { providerTitle } from '../vector/support';
import { vectorEndpoints } from '../adapters/explorer';
import MultiRemoveConfirmDialog from './MultiRemoveConfirmDialog';
import RemoveConfirmDialog from './RemoveConfirmDialog';

/** A controller that never has anything pending (no active connection). */
const IDLE = { subscribe: () => () => undefined, getState: () => null } as const;

/**
 * Where a connection's documents are removed from, as the dialogs say it.
 *
 * @param entry - The connection.
 * @returns The context.
 */
export function removeContext(entry: IConnectionEntry): IRemoveContext {
	const probe = vectorEndpoints.getState().probes[entry.key];
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	const endpoint = entry.ctx.endpoint;
	return { storeName: endpoint.nodeName || providerTitle(endpoint.provider), collection: dialect?.collection ?? null, backend: dialect?.backend ?? providerTitle(endpoint.provider), provider: endpoint.provider };
}

/**
 * The host.
 *
 * @returns The dialog of the active connection's pending confirmation, or nothing.
 */
export function RemoveDialogHost(): React.ReactElement | null {
	const key = useActiveConnection();
	const entry = key ? existingEntry(key) : undefined;
	const source = entry?.controller ?? IDLE;
	const pending = useSyncExternalStore(
		source.subscribe,
		() => (entry ? entry.controller.getState().confirm : null),
		() => null
	);
	if (!entry || pending === null) return null;
	const ctx = removeContext(entry);
	const confirm = (): void => void entry.controller.confirmRemove();
	const cancel = (): void => entry.controller.cancelRemove();
	const dialogKey = `${pending.action}:${pending.targets.length}:${pending.targets[0]?.objectId ?? ''}`;
	if (pending.action === 'empty') return <MultiRemoveConfirmDialog key={dialogKey} content={emptyTrashConfirmation(pending.targets, ctx)} onConfirm={confirm} onCancel={cancel} />;
	if (pending.kind === 'single') {
		const content = pending.action === 'trash' ? trashConfirmation(pending.targets[0], ctx) : removeConfirmation(pending.targets[0], ctx);
		return <RemoveConfirmDialog key={dialogKey} content={content} onConfirm={confirm} onCancel={cancel} />;
	}
	const content = pending.action === 'trash' ? multiTrashConfirmation(pending.targets, ctx) : multiRemoveConfirmation(pending.targets, ctx);
	return <MultiRemoveConfirmDialog key={dialogKey} content={content} onConfirm={confirm} onCancel={cancel} />;
}

export default RemoveDialogHost;

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
// ADAPTER - REACT BINDINGS (the only vector-ui file importing the library's shell-bound modules)
// =============================================================================
//
// `shared/explorer/react` imports values from `shell` (the preference hook,
// the task-event watch), so it is kept out of the pure adapter and imported
// here once. The hooks below subscribe the views to the external stores.
// =============================================================================

import { useMemo, useSyncExternalStore } from 'react';
import { createHistoryPrefsBridge, useEndpointState, useEndpointStoreLifecycle } from 'shared/explorer/react';
import type { IEndpointState, IExplorerClient, IExplorerEndpoint } from 'shared/explorer';
import type { ConsoleModel, SelectionState, VectorChannels } from '../contract/types';
import { buildConsoleModel } from '../vector/consoleModel';
import type { IConsoleState } from '../vector/consoleStore';
import { DEFAULT_LIMITS, readDialect } from '../vector/results';
import { vectorChannels } from './actions';
import { connectionEntry } from './connections';
import type { ConsoleTab, IConnectionEntry, IValueStore } from './connections';
import { activeConnection, vectorEndpoints, vectorHistory } from './explorer';

export { useEndpointStoreLifecycle };

/** Mount once near the root: keeps chat history's access to workspace preferences alive. */
export const VectorHistoryPrefsBridge = createHistoryPrefsBridge(vectorHistory);

/**
 * Subscribe to endpoint discovery and probe state.
 *
 * @returns The current snapshot.
 */
export function useVectorEndpoints(): IEndpointState {
	return useEndpointState(vectorEndpoints);
}

/** The active connection's key (the sidebar follows the active document). */
export const useActiveConnection = activeConnection.use;

/**
 * Subscribe to a value store.
 *
 * @param store - The store.
 * @returns Its value.
 */
export function useValue<T>(store: IValueStore<T>): T {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * The live endpoint for a document: the store's current record when it has
 * one (a restarted pipeline shows its new state), else what the tab was opened
 * with, marked stopped when a successful discovery no longer lists it.
 *
 * @param opened - The endpoint the tab was opened with.
 * @returns The endpoint to show.
 */
export function useLiveEndpoint(opened: IExplorerEndpoint): IExplorerEndpoint {
	const { status, endpoints } = useVectorEndpoints();
	const live = endpoints.find((e) => e.key === opened.key);
	if (live) return live;
	if (status === 'ready') return { ...opened, state: 'stopped', stateDetail: 'This pipeline is no longer running. Start it, then refresh the connections.' };
	return opened;
}

/** Everything a console or a document tab of one connection renders from. */
export interface IConnectionView {
	entry: IConnectionEntry;
	console: IConsoleState;
	selection: SelectionState;
	tab: ConsoleTab;
	chatScope: readonly string[] | null;
	model: ConsoleModel;
	channels: VectorChannels;
}

/**
 * One connection's objects, model and channels, kept in step with the live endpoint and its probe.
 *
 * @param endpoint - The live endpoint.
 * @param client - The client, or null.
 * @returns The view.
 */
export function useConnection(endpoint: IExplorerEndpoint, client: IExplorerClient | null): IConnectionView {
	const { probes } = useVectorEndpoints();
	const probe = probes[endpoint.key];
	const limits = (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS;
	const entry = connectionEntry(endpoint, client, limits);
	const consoleState = useSyncExternalStore(entry.controller.subscribe, entry.controller.getState, entry.controller.getState);
	const selection = useSyncExternalStore(entry.selection.subscribe, entry.selection.getState, entry.selection.getState);
	const tab = useValue(entry.tab);
	const chatScope = useValue(entry.chatScope);
	const scope = useValue(entry.scope);
	const model = useMemo(() => ({ ...buildConsoleModel(endpoint, probe, consoleState.stats.view), scope }), [endpoint, probe, consoleState.stats.view, scope]);
	const channels = useMemo(() => (client ? vectorChannels(vectorEndpoints, client, endpoint) : { tools: null, chat: null, ingest: null }), [client, endpoint]);
	return { entry, console: consoleState, selection, tab, chatScope, model, channels };
}

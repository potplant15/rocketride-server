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
// SAVED QUERIES — THE FULL APP'S (the shell's workspace preferences)
// =============================================================================
//
// The full app keeps saved queries in the shell's workspace preferences, key
// `sql.savedQueries`, through the same stable accessor history uses
// (SqlApp.tsx over `usePrefs`). Those preferences are the signed-in user's,
// so nothing is held here: every read goes to the accessor, and the parsed
// bag is cached only for as long as the account and the stored value are the
// same. While nobody is signed in nothing is read or written.
//
// Dev-tool frames never import this module (localEnv.ts is the full app's).
// =============================================================================

import { useSyncExternalStore } from 'react';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { APP_SAVED_QUERIES_NOTICE, SAVED_QUERIES_PREF, editSavedQueriesIn, readSavedQueriesBag } from './savedQueries';
import type { SavedQueriesBag, SavedQuery, SavedQueryEdit, SqlSavedQueriesApi } from './savedQueries';
import type { SqlEndpoint } from '../connect';

/** Shared empty list, so an unknown connection keeps a stable snapshot. */
const NO_QUERIES: SavedQuery[] = [];

/**
 * The full app's saved queries over its workspace preferences.
 *
 * @param prefs - The shell's workspace preferences (a stable accessor over `usePrefs`).
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The views' API.
 */
export function createLocalSavedQueries(prefs: IPrefsAccessor, ownerNow: () => string | null): SqlSavedQueriesApi {
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};
	/** The last bag parsed, with what it was parsed from (a new object with the same text is the same bag). */
	let cache: { owner: string; raw: unknown; text: string; bag: SavedQueriesBag } | null = null;

	/**
	 * The signed-in account's bag (empty while nobody is signed in).
	 *
	 * @returns The bag; the same object until the account or the stored value changes.
	 */
	const bag = (): SavedQueriesBag => {
		const owner = ownerNow();
		if (owner === null) return {};
		const raw = prefs.getPref(SAVED_QUERIES_PREF);
		if (cache !== null && cache.owner === owner && cache.raw === raw) return cache.bag;
		const text = JSON.stringify(raw ?? null);
		if (cache === null || cache.owner !== owner || cache.text !== text) cache = { owner, raw, text, bag: readSavedQueriesBag(raw) };
		else cache = { ...cache, raw };
		return cache.bag;
	};

	/**
	 * Apply one change for the signed-in account.
	 *
	 * @param endpoint - The connection.
	 * @param change - The change.
	 * @param verb - What it does, for the refusal ('saved', 'renamed', 'deleted').
	 */
	const edit = async (endpoint: SqlEndpoint, change: SavedQueryEdit, verb: string): Promise<void> => {
		if (ownerNow() === null) throw new ExplorerToolError({ kind: 'unavailable', tool: 'savedQueryEdit', message: `Not signed in to a RocketRide server, so nothing was ${verb}.` });
		editSavedQueriesIn(prefs, endpoint.key, change);
		listeners.forEach((listener) => listener());
	};

	return {
		useSavedQueries(endpoint) {
			return useSyncExternalStore(subscribe, () => bag()[endpoint.key] ?? NO_QUERIES);
		},
		usePrivacyNotice: () => APP_SAVED_QUERIES_NOTICE,
		save: (endpoint, query) => edit(endpoint, { action: 'add', query }, 'saved'),
		rename: (endpoint, id, name) => edit(endpoint, { action: 'rename', id, name }, 'renamed'),
		remove: (endpoint, id) => edit(endpoint, { action: 'remove', id }, 'deleted'),
	};
}

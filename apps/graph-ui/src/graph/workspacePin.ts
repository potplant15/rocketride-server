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

// =============================================================================
// GRAPH - THE FULL APP'S WORKSPACE PREFERENCES: WHOSE THEY ARE
// =============================================================================
//
// Ported from sql-ui (history/workspacePin.ts). The shell reads an app's
// workspace preferences from the signed-in account's file once per page, and
// writes the WHOLE bag back, through whoever is signed in at that moment,
// whenever any key changes. So after another account signs in without a
// reload, the bag in memory is still the first account's, and any write, of
// any key, copies all of it into the next account's file.
//
// So the full app pins the first account it sees. What Graph Explorer keeps in
// those preferences itself (drafts, captions, grid layouts, label styles and
// saved queries) asks this pin first, and for any other account reads nothing
// and writes nothing until the page reloads, or until the first account is
// back, whose bag it still is. While nobody is signed in nothing is read or
// written either. (History goes through the shared library's own bridge.)
//
// ONE PIN PER PAGE (APP_WORKSPACE_PIN), like the shell's own read: it must
// outlive an env rebuild and the app being switched away and back.
//
// Dev-tool mounts never use it: their preferences are session-only, and the
// controller keeps one section per account in its own files.
// =============================================================================

import type { IDataGridPersistence } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IPrefsAccessor } from 'shared/explorer';
import { APP_USER_DATA_NOTE, createStoredUserData } from './userData';
import type { IOwnedUserData } from './userData';

/** Where the account signed in now stands against the preferences in memory. */
export type WorkspaceAccess = 'nobody' | 'owner' | 'another';

/** Whose workspace preferences these are. */
export interface IWorkspacePin {
	/**
	 * Where an account stands. The first account given binds; null is nobody and binds nothing.
	 *
	 * @param owner - The identity fingerprint, or null when nobody is signed in.
	 * @returns `owner` for the bound account, `another` for any other, `nobody` for null.
	 */
	access(owner: string | null): WorkspaceAccess;
}

/** What a view says instead of another account's styles and saved queries. */
export const ANOTHER_ACCOUNT_USER_DATA = 'Signed in as a different account: reload the page to see your saved queries and styles.';

/**
 * Make a pin. The full app has one, {@link APP_WORKSPACE_PIN}; tests make their own.
 *
 * @returns The pin, bound to nobody yet.
 */
export function createWorkspacePin(): IWorkspacePin {
	let pinned: string | null = null;
	return {
		access(owner) {
			if (owner === null) return 'nobody';
			pinned ??= owner;
			return owner === pinned ? 'owner' : 'another';
		},
	};
}

/** The full app's pin: one per page, as the shell reads the preferences once per page. */
export const APP_WORKSPACE_PIN: IWorkspacePin = createWorkspacePin();

/**
 * Preferences that read and write through only for the pinned account.
 *
 * @param pin - The pin.
 * @param prefs - The shell's workspace preferences.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded accessor: reads undefined and drops writes for anyone else.
 */
export function pinnedPrefs(pin: IWorkspacePin, prefs: IPrefsAccessor, ownerNow: () => string | null): IPrefsAccessor {
	return {
		getPref: (key) => (pin.access(ownerNow()) === 'owner' ? prefs.getPref(key) : undefined),
		setPref: (key, value) => {
			if (pin.access(ownerNow()) === 'owner') prefs.setPref(key, value);
		},
	};
}

/**
 * Grid layouts that read and write through only for the pinned account. The shell keeps them in the same preferences
 * bag, so a layout written for another account would carry the first account's bag with it.
 *
 * @param pin - The pin.
 * @param grids - The layouts' own persistence.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded persistence: nothing stored for anyone else, and nothing kept.
 */
export function pinnedGrids(pin: IWorkspacePin, grids: IDataGridPersistence, ownerNow: () => string | null): IDataGridPersistence {
	const owns = (): boolean => pin.access(ownerNow()) === 'owner';
	return {
		read: (tableId, type) => (owns() ? grids.read(tableId, type) : false),
		write: (tableId, type, data) => {
			if (owns()) grids.write(tableId, type, data);
		},
		clear: (tableId) => {
			if (owns()) grids.clear(tableId);
		},
	};
}

/**
 * The full app's styles and saved queries: the workspace preferences, for the pinned account only. Nobody signed in,
 * or another account, reads nothing (the saved queries say why) and changes nothing (refused with the reason).
 * GraphApp calls `notify()` when the account changes.
 *
 * @param prefs - The shell's workspace preferences (a stable accessor over `usePrefs`).
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @param pin - Whose preferences these are (default: the page's).
 * @param now - The clock.
 * @returns The user data.
 */
export function createAppUserData(prefs: IPrefsAccessor, ownerNow: () => string | null, pin: IWorkspacePin = APP_WORKSPACE_PIN, now: () => number = Date.now): IOwnedUserData {
	const pinned = pinnedPrefs(pin, prefs, ownerNow);
	return createStoredUserData(
		{
			read() {
				const access = pin.access(ownerNow());
				if (access === 'owner') return { status: 'ready', prefs: pinned };
				return { status: 'error', note: access === 'nobody' ? 'Not signed in to a RocketRide server.' : ANOTHER_ACCOUNT_USER_DATA };
			},
			async accessor(tool) {
				const access = pin.access(ownerNow());
				if (access === 'nobody') throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Not signed in to a RocketRide server, so nothing was changed.' });
				if (access === 'another') throw new ExplorerToolError({ kind: 'stale', tool, message: 'Signed in as a different account, so nothing was changed. Reload the page to see and change your saved queries and styles.' });
				return pinned;
			},
			privacyNote: () => APP_USER_DATA_NOTE,
		},
		now,
	);
}

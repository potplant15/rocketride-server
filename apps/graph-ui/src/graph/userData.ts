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
// GRAPH - USER DATA (label styles and saved queries, per connection)
// =============================================================================
//
// What a person keeps for a connection besides history: how each label and
// relationship type is drawn, and the queries they saved. Every mount reaches
// it through `env.userData` (IGraphUserData); where it is kept differs per
// mount, and `privacyNote` says so in one true sentence.
//
// Colour slots index the shell's six chart colours (graph/colors.ts
// CHART_COLOR_VARS). `assigned` is written by the realm that owns the schema
// when it first sees a label, and never rewritten, so adding labels to a graph
// never moves the colour of a label already drawn.
//
// WHERE THEY ARE KEPT (the bags themselves: graph/userDataStore.ts)
//
//   full app      the workspace preferences, behind the page's pin
//                 (graph/workspacePin.ts): GraphApp builds a stored user data
//                 over them;
//   dev tool      the CONTROLLER's file, one section per account
//                 (graph/userDataFile.ts): the controller builds a stored
//                 user data over it, and frames reach it through ops
//                 (devtool/remoteUserData.ts);
//   anything else memory, for the session (`createMemoryUserData`).
//
// A stored user data reads synchronously through whatever accessor its source
// holds now, and waits (bounded) for one before a change. The realm that owns
// the schema also gives labels their first-seen colour slots
// (`followAssignments`). Nothing here holds a client, so a frame can import it.
// =============================================================================

import type { IPrefsAccessor } from 'shared/explorer';
import type { IReadable } from '../env';
import { nextAssignments } from './colors';
import type { ISchemaStore } from './schemaStore';
import { EMPTY_STYLE, SAVED_QUERIES_PREF, editSavedIn, editStyleIn, savedQueriesIn, styleIn } from './userDataStore';

// =============================================================================
// TYPES
// =============================================================================

/** A node's drawn size. */
export type LabelSize = 'S' | 'M' | 'L';

/** What a node shows inside its circle. */
export type BadgeMode = 'initials' | 'dot' | 'none';

/** A person's choices for one label (unset members follow the defaults). */
export interface ILabelStyle {
	/** Index into CHART_COLOR_VARS. */
	slot?: number;
	size?: LabelSize;
	badge?: BadgeMode;
}

/** A person's choices for one relationship type. */
export interface ITypeStyle {
	/** Index into CHART_COLOR_VARS. */
	slot?: number;
}

/** How one connection's labels and relationship types are drawn. */
export interface IConnectionStyle {
	/** Colour slot per label, given once when the label is first seen and kept, so adding labels never shifts colours. */
	assigned: Readonly<Record<string, number>>;
	labels: Readonly<Record<string, ILabelStyle>>;
	types: Readonly<Record<string, ITypeStyle>>;
}

/** The style of a connection nobody has styled (defined with the bags, which read it). */
export { EMPTY_STYLE };

/** A change to a connection's style (null resets that label or type; `reset` resets them all, keeping `assigned`). */
export type StyleEdit = { kind: 'label'; label: string; style: ILabelStyle | null } | { kind: 'type'; type: string; style: ITypeStyle | null } | { kind: 'reset' };

/** One saved query. */
export interface ISavedQuery {
	id: string;
	name: string;
	cypher: string;
	/** Epoch ms. */
	savedAt: number;
}

/**
 * One connection's saved queries as a view shows them. `session`: kept for this session only (no store could be
 * used); `note` says why something is missing or refused, else null.
 */
export interface ISavedQueriesView {
	status: 'loading' | 'ready' | 'session' | 'error';
	queries: readonly ISavedQuery[];
	note: string | null;
}

/** A change to a connection's saved queries. */
export type SavedEdit = { action: 'save'; name: string; cypher: string } | { action: 'rename'; id: string; name: string } | { action: 'delete'; id: string };

/** Styles and saved queries, as every mount offers them. */
export interface IGraphUserData {
	/** One connection's style (one stable readable per key). */
	style(key: string): IReadable<IConnectionStyle>;
	/** Resolves once applied, rejects with the reason. */
	editStyle(key: string, edit: StyleEdit): Promise<void>;
	/** One connection's saved queries (one stable readable per key). */
	saved(key: string): IReadable<ISavedQueriesView>;
	/** Resolves once applied, rejects with the reason. */
	editSaved(key: string, edit: SavedEdit): Promise<void>;
	/** One true sentence: where styles and saved queries are kept on this mount. */
	privacyNote: string;
}

// =============================================================================
// PURE EDITS
// =============================================================================

/**
 * Apply a style edit.
 *
 * @param style - The current style.
 * @param edit - The change.
 * @returns The new style (the same object when nothing changed).
 */
export function applyStyleEdit(style: IConnectionStyle, edit: StyleEdit): IConnectionStyle {
	switch (edit.kind) {
		case 'reset':
			return Object.keys(style.labels).length === 0 && Object.keys(style.types).length === 0 ? style : { assigned: style.assigned, labels: {}, types: {} };
		case 'label': {
			const labels: Record<string, ILabelStyle> = { ...style.labels };
			if (edit.style === null) delete labels[edit.label];
			else labels[edit.label] = { ...edit.style };
			return { ...style, labels };
		}
		case 'type': {
			const types: Record<string, ITypeStyle> = { ...style.types };
			if (edit.style === null) delete types[edit.type];
			else types[edit.type] = { ...edit.style };
			return { ...style, types };
		}
	}
}

// =============================================================================
// PRIVACY NOTES (one true sentence per mount)
// =============================================================================

/** The note of a session-only store. */
export const SESSION_USER_DATA_NOTE = 'Kept for this session only: styles and saved queries are not saved anywhere.';

/** The full app's note: they ride the shell's workspace preferences. */
export const APP_USER_DATA_NOTE = 'Saved in your RocketRide workspace file on the server, for your account, not in this browser.';

/** Where the dev tool's controller keeps them: its file, this session only (the file could not be read), or nowhere (nobody signed in). */
export type UserDataStorage = 'file' | 'session' | 'none';

/**
 * The dev tool's note for where its controller keeps them.
 *
 * @param storage - Where they are kept.
 * @returns The sentence.
 */
export function devToolUserDataNote(storage: UserDataStorage): string {
	switch (storage) {
		case 'file':
			return 'Saved on the server in your user folder (rocketride.graph.saved.json), for your account. If two windows save at once, the last one wins.';
		case 'session':
			return 'Kept for this session only: rocketride.graph.saved.json in your user folder could not be read, so nothing is written to it.';
		default:
			return 'Not saved: nobody is signed in to a RocketRide server.';
	}
}

// =============================================================================
// THE STORED IMPLEMENTATION (over an accessor its source holds)
// =============================================================================

/** Where reading stands on a mount, right now: an accessor to read through, or why there is none. */
export type UserDataRead = { status: 'ready' | 'session'; prefs: IPrefsAccessor } | { status: 'loading' | 'error'; note: string | null };

/** Where a stored user data keeps its bags. Its owner calls `notify()` on the user data whenever `read()` may answer differently. */
export interface IUserDataSource {
	/** Where reading stands now (synchronous). */
	read(): UserDataRead;
	/**
	 * The accessor to read or change, once it can be (may wait, bounded).
	 *
	 * @param tool - What asks (named in errors).
	 * @returns The accessor.
	 * @throws ExplorerToolError when nobody may be served (nobody signed in, another account, not read in time).
	 */
	accessor(tool: string): Promise<IPrefsAccessor>;
	/** A change was made through the accessor. */
	changed?(): void;
	/** Where they are kept, in one sentence. */
	privacyNote(): string;
}

/** A user data owned by a realm that holds its bags: the full app, the controller, or memory. */
export interface IOwnedUserData extends IGraphUserData {
	/**
	 * Change a style. `check` runs right before the write, after any wait (the controller re-checks the caller's account there).
	 *
	 * @returns Once written.
	 */
	editStyle(key: string, edit: StyleEdit, check?: () => void): Promise<void>;
	/** Change the saved queries; `check` as for {@link editStyle}. */
	editSaved(key: string, edit: SavedEdit, check?: () => void): Promise<void>;
	/** Give labels seen for the first time their colour slots, when the bags can be written now (else nothing). */
	assign(key: string, labels: Iterable<string>): void;
	/** Read again: the source's state, or the account, may have changed. */
	notify(): void;
	/** Be told about every change, of any connection. */
	subscribe(listener: () => void): () => void;
}

/** No saved queries (shared, so snapshots stay stable). */
const NO_QUERIES: readonly ISavedQuery[] = Object.freeze([]) as readonly ISavedQuery[];

/**
 * A view of one connection's saved queries, the same object while nothing in it changed.
 *
 * @param last - The previous view, or null.
 * @param next - The new one.
 * @returns `last` when equal, else `next`.
 */
function sameView(last: ISavedQueriesView | null, next: ISavedQueriesView): ISavedQueriesView {
	if (last && last.status === next.status && last.note === next.note && last.queries.length === next.queries.length && JSON.stringify(last.queries) === JSON.stringify(next.queries)) return last;
	return next;
}

let idCounter = 0;

/**
 * A saved query id: unique within a realm, and across realms in practice.
 *
 * @param now - The clock.
 * @returns The id.
 */
export function newSavedId(now: () => number = Date.now): string {
	idCounter += 1;
	return `q-${now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Styles and saved queries over a source's accessor. Reads are synchronous and stable (one object per connection
 * until it changes); a change waits for the source, refuses past a bound with a sentence, and is told to every
 * subscriber once written.
 *
 * @param source - Where the bags are.
 * @param now - The clock (saved queries' ids and times).
 * @returns The user data.
 */
export function createStoredUserData(source: IUserDataSource, now: () => number = Date.now): IOwnedUserData {
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const notify = (): void => listeners.forEach((listener) => listener());
	const styleReadables = new Map<string, IReadable<IConnectionStyle>>();
	const savedReadables = new Map<string, IReadable<ISavedQueriesView>>();
	// One cached style per key, by its JSON text, so a host that hands out a new object for the same value (the shell's
	// preferences) still gives a stable snapshot.
	const styles = new Map<string, { text: string; style: IConnectionStyle }>();
	// One view per key, with the stored bag it was read from: the same bag object (most hosts) is not read again.
	const views = new Map<string, { raw: unknown; view: ISavedQueriesView }>();

	const styleOf = (key: string): IConnectionStyle => {
		const read = source.read();
		if (!('prefs' in read)) return EMPTY_STYLE;
		const style = styleIn(read.prefs, key);
		const cached = styles.get(key);
		if (cached && cached.style === style) return style;
		const text = JSON.stringify(style);
		if (cached && cached.text === text) return cached.style;
		styles.set(key, { text, style });
		return style;
	};
	const savedOf = (key: string): ISavedQueriesView => {
		const read = source.read();
		const last = views.get(key) ?? null;
		const raw = 'prefs' in read ? read.prefs.getPref(SAVED_QUERIES_PREF) : null;
		if (last && last.raw === raw && last.view.status === read.status && raw !== null && raw !== undefined) return last.view;
		const next: ISavedQueriesView = 'prefs' in read ? { status: read.status, queries: savedQueriesIn(read.prefs, key), note: null } : { status: read.status, queries: NO_QUERIES, note: read.note };
		const view = sameView(last?.view ?? null, next);
		views.set(key, { raw, view });
		return view;
	};
	const wrote = (): void => {
		notify();
		source.changed?.();
	};

	return {
		get privacyNote() {
			return source.privacyNote();
		},
		style(key) {
			let readable = styleReadables.get(key);
			if (!readable) {
				readable = { get: () => styleOf(key), subscribe };
				styleReadables.set(key, readable);
			}
			return readable;
		},
		saved(key) {
			let readable = savedReadables.get(key);
			if (!readable) {
				readable = { get: () => savedOf(key), subscribe };
				savedReadables.set(key, readable);
			}
			return readable;
		},
		async editStyle(key, edit, check) {
			const prefs = await source.accessor('userDataEdit');
			check?.();
			if (editStyleIn(prefs, key, edit)) wrote();
		},
		async editSaved(key, edit, check) {
			const prefs = await source.accessor('userDataEdit');
			check?.();
			editSavedIn(prefs, key, edit, { id: newSavedId(now), at: now() });
			wrote();
		},
		assign(key, labels) {
			const read = source.read();
			if (!('prefs' in read)) return;
			const fresh = nextAssignments(styleIn(read.prefs, key).assigned, labels);
			if (Object.keys(fresh).length > 0 && editStyleIn(read.prefs, key, { kind: 'assign', assigned: fresh })) wrote();
		},
		notify,
		subscribe,
	};
}

/**
 * Styles and saved queries kept in memory for this session.
 *
 * @param privacyNote - Where this mount keeps them (true for the mount).
 * @param now - The clock.
 * @returns The user data.
 */
export function createMemoryUserData(privacyNote: string, now: () => number = Date.now): IOwnedUserData {
	const values = new Map<string, unknown>();
	const prefs: IPrefsAccessor = { getPref: (key) => values.get(key), setPref: (key, value) => void values.set(key, value) };
	return createStoredUserData({ read: () => ({ status: 'session', prefs }), accessor: async () => prefs, privacyNote: () => privacyNote }, now);
}

/**
 * Give every loaded schema's labels their first-seen colour slots, in the realm that owns the schema: now, on every
 * schema change, and whenever the user data can be written again (a file read, an account back).
 *
 * @param schemas - The realm's schema store.
 * @param userData - The realm's user data.
 * @returns Stop following.
 */
export function followAssignments(schemas: ISchemaStore, userData: IOwnedUserData): () => void {
	let running = false;
	const run = (): void => {
		// An assignment notifies, which runs this again: once is enough (it finds nothing new).
		if (running) return;
		running = true;
		try {
			for (const key of schemas.keys()) {
				const entry = schemas.get(key);
				if (entry.loadedAt > 0 && entry.view.labels.length > 0) userData.assign(key, entry.view.labels.map((label) => label.name));
			}
		} finally {
			running = false;
		}
	};
	const offSchemas = schemas.subscribe(run);
	const offData = userData.subscribe(run);
	run();
	return () => {
		offSchemas();
		offData();
	};
}

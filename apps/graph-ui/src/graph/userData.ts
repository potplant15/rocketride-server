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
// This module is types, pure edits and a session-only implementation; it holds
// no client, so a frame can import it.
// =============================================================================

import type { IReadable } from '../env';

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

/** The style of a connection nobody has styled. */
export const EMPTY_STYLE: IConnectionStyle = Object.freeze({ assigned: Object.freeze({}), labels: Object.freeze({}), types: Object.freeze({}) });

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
// SESSION-ONLY IMPLEMENTATION
// =============================================================================

/** The note of a session-only store. */
export const SESSION_USER_DATA_NOTE = 'Styles and saved queries are kept for this session only and are not saved anywhere.';

/** The empty saved-queries view of a session-only store. */
const SESSION_EMPTY: ISavedQueriesView = Object.freeze({ status: 'session', queries: Object.freeze([]) as readonly ISavedQuery[], note: null });

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
 * Styles and saved queries kept in memory for this session.
 *
 * @param privacyNote - Where this mount keeps them (true for the mount).
 * @param now - The clock.
 * @returns The user data.
 */
export function createMemoryUserData(privacyNote: string, now: () => number = Date.now): IGraphUserData {
	const styles = new Map<string, IConnectionStyle>();
	const saved = new Map<string, ISavedQueriesView>();
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
	return {
		privacyNote,
		style(key) {
			let readable = styleReadables.get(key);
			if (!readable) {
				readable = { get: () => styles.get(key) ?? EMPTY_STYLE, subscribe };
				styleReadables.set(key, readable);
			}
			return readable;
		},
		editStyle: async (key, edit) => {
			const before = styles.get(key) ?? EMPTY_STYLE;
			const after = applyStyleEdit(before, edit);
			if (after === before) return;
			styles.set(key, after);
			notify();
		},
		saved(key) {
			let readable = savedReadables.get(key);
			if (!readable) {
				readable = { get: () => saved.get(key) ?? SESSION_EMPTY, subscribe };
				savedReadables.set(key, readable);
			}
			return readable;
		},
		editSaved: async (key, edit) => {
			const queries = (saved.get(key) ?? SESSION_EMPTY).queries;
			let next: readonly ISavedQuery[];
			switch (edit.action) {
				case 'save':
					next = [{ id: newSavedId(now), name: edit.name, cypher: edit.cypher, savedAt: now() }, ...queries];
					break;
				case 'rename':
					if (!queries.some((query) => query.id === edit.id)) throw new Error('That saved query is not there any more.');
					next = queries.map((query) => (query.id === edit.id ? { ...query, name: edit.name } : query));
					break;
				case 'delete':
					next = queries.filter((query) => query.id !== edit.id);
					break;
			}
			saved.set(key, { status: 'session', queries: next, note: null });
			notify();
		},
	};
}

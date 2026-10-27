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
// GRAPH-UI - USER DATA: A FRAME'S VIEW OF THE CONTROLLER'S
// =============================================================================
//
// Ported from sql-ui (history/remoteSavedQueries.ts). In a dev tool the
// controller owns label styles and saved queries (devtool/controller.ts,
// graph/userDataFile.ts). A frame:
//
//   reads    a connection's styles and saved queries with `graph.userData`
//            (an op result, which also says where they are kept), on first
//            use and again whenever the retained `userData` topic's revision
//            moves on (another document changed them, the file was read, the
//            account changed);
//   writes   through `graph.userDataEdit` only, carrying the account the frame
//            belongs to; the controller refuses a change for anyone else, and
//            a refusal (a cap, a query gone) reaches the caller.
//
// THE LATEST READ WINS. Every read is sent (none waits for another in flight)
// and only the answer to the newest one is used: a read that is never
// answered (its controller went away) cannot hold back the next, and an older
// answer that arrives late cannot replace a newer one. Until the first answer
// the saved queries read as loading; a failed read says why, and the next
// revision (or identity) reads again.
// =============================================================================

import type { ToolChannel } from 'shell';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import type { IReadable } from '../env';
import { EMPTY_STYLE } from '../graph/userData';
import type { IConnectionStyle, IGraphUserData, ISavedQueriesView, SavedEdit, StyleEdit } from '../graph/userData';
import { OP, STATE, field, frameTimeoutFor, toWire } from './protocol';
import type { GraphOps, IUserDataAnswer, UserDataChange } from './protocol';

/** A frame's user data, with its lifetime. */
export interface IRemoteUserData extends IGraphUserData {
	/** Forget everything read (an identity reset), and read again what is watched. */
	reset(): void;
	/** Read again what is watched and not current (the host connection is back). */
	retry(): void;
	/** Stop following the channel. */
	dispose(): void;
}

/** What {@link createRemoteUserData} needs. */
export interface IRemoteUserDataOptions {
	caller: IFrameCaller<GraphOps>;
	channel: ToolChannel;
	/** The fingerprint of the account the frame belongs to (null before it is known). */
	owner(): string | null;
	/** Whether the host connection is up (nothing is read while it is not). */
	connected(): boolean;
	/** Told about a failed read nobody awaits. */
	onError?: (error: unknown) => void;
}

/** Shared views, so snapshots stay stable. */
const LOADING: ISavedQueriesView = Object.freeze({ status: 'loading', queries: Object.freeze([]), note: null }) as ISavedQueriesView;

/** What the view holds for one connection. */
interface ISlot {
	style: IConnectionStyle;
	saved: ISavedQueriesView;
	/** The revision the last answer was for (null: not read yet). */
	rev: number | null;
	/** The newest read sent: only its answer is used. */
	seq: number;
	/** Subscribers of this connection's readables. */
	watchers: number;
	styleReadable: IReadable<IConnectionStyle>;
	savedReadable: IReadable<ISavedQueriesView>;
}

/**
 * Read a connection's answer that crossed the channel.
 *
 * @param value - The op's value.
 * @returns The answer, with safe fallbacks.
 */
function asAnswer(value: unknown): IUserDataAnswer {
	const style = field(value, 'style');
	const saved = field(value, 'saved');
	const note = field(value, 'privacyNote');
	const queries = field(saved, 'queries');
	const status = field(saved, 'status');
	return {
		style: style !== null && typeof style === 'object' ? (style as IConnectionStyle) : EMPTY_STYLE,
		saved: {
			status: status === 'ready' || status === 'session' || status === 'loading' || status === 'error' ? status : 'error',
			queries: Array.isArray(queries) ? (queries as ISavedQueriesView['queries']) : [],
			note: typeof field(saved, 'note') === 'string' ? (field(saved, 'note') as string) : null,
		},
		privacyNote: typeof note === 'string' ? note : '',
	};
}

/**
 * Build a frame's user data over its controller.
 *
 * @param opts - See {@link IRemoteUserDataOptions}.
 * @returns The user data; dispose it with the frame.
 */
export function createRemoteUserData(opts: IRemoteUserDataOptions): IRemoteUserData {
	const { caller, channel } = opts;
	const slots = new Map<string, ISlot>();
	// One entry per subscription, so the same function subscribed twice is told (and removed) per subscription.
	const listeners = new Set<{ fn: () => void }>();
	let rev: number | null = null;
	let epoch = 0;
	let note = '';
	const notify = (): void => listeners.forEach((entry) => entry.fn());

	/**
	 * Read one connection from the controller.
	 *
	 * @param key - The endpoint key.
	 */
	const fetch = (key: string): void => {
		const slot = slots.get(key);
		// Not before the frame knows its account (the identity topic reads again then): the controller would refuse it.
		if (!slot || !opts.connected() || opts.owner() === null) return;
		slot.seq += 1;
		const seq = slot.seq;
		const asked = epoch;
		const askedRev = rev;
		// Only the newest read of a view that was not reset since counts.
		const current = (): boolean => asked === epoch && slots.get(key) === slot && seq === slot.seq;
		caller.callReply(OP.userData, { key, owner: opts.owner() }, { timeoutMs: frameTimeoutFor(OP.userData) }).then(
			(value) => {
				if (!current()) return;
				const answer = asAnswer(value);
				slot.style = answer.style;
				slot.saved = answer.saved;
				slot.rev = askedRev;
				note = answer.privacyNote;
				notify();
			},
			(error: unknown) => {
				if (!current()) return;
				slot.saved = { status: 'error', queries: slot.saved.queries, note: error instanceof Error ? error.message : String(error) };
				notify();
				opts.onError?.(error);
			},
		);
	};
	const refetch = (all: boolean): void => {
		for (const [key, slot] of slots) if (slot.watchers > 0 && (all || slot.rev !== rev || slot.saved.status === 'error' || slot.saved.status === 'loading')) fetch(key);
	};

	const offRev = channel.onState(STATE.userData, (snapshot) => {
		const next = field(snapshot, 'rev');
		if (typeof next !== 'number' || next === rev) return;
		rev = next;
		refetch(false);
	});
	// A read refused because the frame had not yet learnt its account is tried again once the controller vouches for
	// one (after this tick, so the frame's identity guard has taken it first).
	const offIdentity = channel.onState(STATE.identity, (snapshot) => {
		const fingerprint = field(snapshot, 'fingerprint');
		if (typeof fingerprint !== 'string' || fingerprint === '') return;
		queueMicrotask(() => refetch(false));
	});

	const slotOf = (key: string): ISlot => {
		let slot = slots.get(key);
		if (!slot) {
			const subscribe = (listener: () => void): (() => void) => {
				const entry = { fn: listener };
				listeners.add(entry);
				created.watchers += 1;
				if (created.watchers === 1 && created.rev === null) fetch(key);
				return () => {
					if (listeners.delete(entry)) created.watchers -= 1;
				};
			};
			const created: ISlot = {
				style: EMPTY_STYLE,
				saved: LOADING,
				rev: null,
				seq: 0,
				watchers: 0,
				styleReadable: { get: () => created.style, subscribe },
				savedReadable: { get: () => created.saved, subscribe },
			};
			slot = created;
			slots.set(key, slot);
		}
		return slot;
	};

	/**
	 * Send one change and read the connection again; a refusal reaches the caller.
	 *
	 * @param key - The connection.
	 * @param change - The change.
	 */
	const edit = async (key: string, change: UserDataChange): Promise<void> => {
		await caller.callReply(OP.userDataEdit, toWire({ key, owner: opts.owner(), change }), { timeoutMs: frameTimeoutFor(OP.userDataEdit) });
		fetch(key);
	};

	return {
		// Nothing until the controller has said where they are kept (never a guess).
		get privacyNote() {
			return note;
		},
		style: (key) => slotOf(key).styleReadable,
		saved: (key) => slotOf(key).savedReadable,
		editStyle: (key, change: StyleEdit) => edit(key, { target: 'style', edit: change }),
		editSaved: (key, change: SavedEdit) => edit(key, { target: 'saved', edit: change }),
		retry: () => refetch(false),
		reset() {
			epoch += 1;
			note = '';
			for (const slot of slots.values()) {
				slot.style = EMPTY_STYLE;
				slot.saved = LOADING;
				slot.rev = null;
			}
			notify();
			refetch(true);
		},
		dispose() {
			offRev();
			offIdentity();
			epoch += 1;
			listeners.clear();
		},
	};
}

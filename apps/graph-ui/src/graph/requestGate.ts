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
// GRAPH - REQUEST GATE (one request at a time per workbench, across its tabs)
// =============================================================================
//
// Every query tab of a workbench has its own runner and graph session, so
// without a gate a workbench could hold several requests on the database at
// once. Apache AGE's node has a pool of four connections, and a request the user
// stopped waiting for keeps its connection until the database finishes it (up
// to the statement timeout), so a few tabs could leave the next request waiting
// for a free connection until it fails as "busy".
//
// The gate lets one request through at a time and counts it until its promise
// SETTLES, not until the user stops waiting. A request asked for while one is in
// flight is refused before anything is sent, with a sentence, as a tool error of
// kind `unavailable` (so a write that was refused here is never reported as one
// that may have been applied).
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';

/** What a refused request says. */
export const GATE_BUSY_TEXT = 'Not sent: an earlier request from this workbench is still running on the database. A workbench sends one request at a time, and one you stopped waiting for counts until the database finishes it. Try again in a moment.';

/** The gate. */
export interface IRequestGate {
	/** Why a request cannot be sent now, or null when the gate is free. */
	busy(): string | null;
	/**
	 * Send a request through the gate.
	 *
	 * @param tool - The tool it calls (named in the refusal).
	 * @param send - Sends it.
	 * @returns Its answer; rejects with its error, or with a "not sent" tool error when the gate is busy.
	 */
	send<T>(tool: string, send: () => Promise<T>): Promise<T>;
	/** Be told when the gate becomes busy or free; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/**
 * Create a gate.
 *
 * @returns A free gate.
 */
export function createRequestGate(): IRequestGate {
	let inFlight = 0;
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	return {
		busy: () => (inFlight > 0 ? GATE_BUSY_TEXT : null),
		async send(tool, send) {
			if (inFlight > 0) throw new ExplorerToolError({ kind: 'unavailable', tool, message: GATE_BUSY_TEXT });
			inFlight += 1;
			notify();
			try {
				return await send();
			} finally {
				inFlight -= 1;
				notify();
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

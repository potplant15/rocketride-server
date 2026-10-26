// MIT License
//
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
// STAGED FILESYSTEM — the git-like workspace view: layers, commit, rollback
// =============================================================================

/**
 * `StagedFileSystem` is a workspace view (IWorkspaceFileSystem) that stages
 * every mutation in local layers instead of writing to the server. It
 * decorates a base view (the host's CachedVfs — typed to the interface,
 * never the class):
 *
 *   - Reads are a top-down union: dirty editor overlay (via the base) wins,
 *     then staged layers newest-first, then the base itself.
 *   - Mutations land in the topmost (working) layer as writes, tombstones,
 *     or mkdirs. The content that was effective BEFORE the first touch is
 *     captured per path (`before` + its hash) — the conflict anchor and the
 *     undo source. Staged mutations never reach the backend; only commit()
 *     holds that path.
 *   - checkpoint() freezes the working layer; rollback() truncates back to
 *     a checkpoint; commit() verifies the captured base hashes against the
 *     live base (conflicts reported, never clobbered) and replays the net
 *     operations onto the base — the single moment the server changes.
 *   - Committed layers can be RETAINED as inert history (auto-commit mode):
 *     they stop contributing to reads and pending state but keep their
 *     before-content so undoTurn() can inverse-replay them.
 *   - An optional staging store persists layers (content-addressed blobs +
 *     manifest); persistence completes before the change tick fires —
 *     persistence IS the save.
 *   - Every path has a version (see version()). A mutation counts when it
 *     is called and then waits its turn behind the path's pending
 *     mutations; reads wait for them too, up to a time limit. A write may
 *     name the version it was computed from (`expect`) and is refused when
 *     the path has moved on, so no writer lands over a change it never saw.
 *   - commit(), undoTurn(), discard(), rollback() and discardPath() run in
 *     the order they are called, each after every mutation called before
 *     it, waiting up to the same time limit. A discard, rollback or path
 *     discard also holds every mutation and read called after it. A commit
 *     holds only the paths it replays, and only for mutations: it carries
 *     what was staged before it was called, freezes those layers, a write
 *     meanwhile opens a new working layer above them, and only the frozen
 *     layers are swept. A commit counts no version and holds no read, since
 *     what the view serves does not change.
 *   - A rename is refused while an editor holds unsaved changes at or under
 *     its source.
 *   - A server read that one of the view's own changes to the base overtook
 *     (a commit's replay that lands while the read is on its way) may hold
 *     the file as it was before the change. The view reads it again, and
 *     drops what a batch read cached for it, so the base's cache never
 *     serves the older file under the newer version. An invalidate counts
 *     the same way.
 *   - The base's cache holds only the server's copy: prime() takes no
 *     content, since what a caller hands back may be an editor's unsaved
 *     buffer or staged content. A staged entry's conflict anchor is the
 *     cached copy the page read, so a commit over a server copy that moved
 *     on since then (another tab, a teammate) meets a conflict. A discard
 *     or rollback still drops the cached copy of what it drops, so the next
 *     read takes the server's copy.
 *   - A write that names a version is also refused when a discard or
 *     rollback called before it drops its path only once it runs (a commit
 *     before the discard met a conflict, so it did not carry the path).
 *
 * Staged content is text-only (the cloud workspace tools are text-only);
 * binary paths flow through untouched in write-through mode only.
 */

import type { IWorkspaceBaseView, IWorkspaceFileSystem, VfsEntry, VfsOverlay } from './vfsTypes';
import { sha256Hex } from './hash';
// The wire-shaped change-management types are OWNED by the shell's
// WorkspaceFs leaf (both hosts and the op layer type against them);
// re-exported here so existing importers keep their path.
import { StaleWriteError, globToRegExp } from 'shell/src/workspace/workspaceFs';
import type { WorkspaceFs, ChangeKind, CommitResult, StagedConflict, LayerMeta, PendingState } from 'shell/src/workspace/workspaceFs';

export { StaleWriteError };
export type { ChangeKind, CommitResult, StagedConflict };

// =============================================================================
// TYPES — layers, entries, results
// =============================================================================

/** One staged operation on one path. */
export type LayerEntry =
	| {
		kind: 'write';
		/** The staged content. */
		content: string;
		/** Effective content below at first touch (null = did not exist). */
		before: string | null;
		/** Hash of `before` (null = did not exist) — the conflict anchor. */
		baseHash: string | null;
		stamp: number;
		/** The number of the view mutation that staged it, in call order; absent once restored from the staging store. */
		seq?: number;
	}
	| {
		kind: 'tombstone';
		/** The deleted file's content at first touch (null for dirs/unknown). */
		before: string | null;
		baseHash: string | null;
		/**
		 * True when the deleted path was a DIRECTORY — dirs have no content
		 * capture, so existence (not a content hash) is their commit anchor.
		 */
		dir?: boolean;
		stamp: number;
		/** See the write entry. */
		seq?: number;
	}
	| {
		kind: 'mkdir';
		stamp: number;
		/** See the write entry. */
		seq?: number;
	};

/** One checkpoint: a frozen (or working) set of staged operations. */
export interface Layer {
	/** Stable id (uuid). */
	id: string;
	/** Display label (e.g. a turn title). */
	label: string;
	/** The agent session that produced it, when any. */
	sessionId?: string;
	/** True once commit() retained this layer as inert undo history. */
	committed?: boolean;
	/** Staged operations, keyed by canonical path. */
	entries: Map<string, LayerEntry>;
}

/**
 * A write refused because its `expect` names an older version than the
 * path's current one: something in this page changed the file after the
 * writer read it. It is a StaleWriteError, so a caller that handles the
 * server-side refusal handles this one too; the fields say which versions
 * and who wrote last.
 */
export class StaleVersionError extends StaleWriteError {
	/** The version the writer computed from. */
	readonly expected: number;
	/** The path's version when the write was refused. */
	readonly actual: number;
	/** Who changed the path last, when known. */
	readonly lastWriter?: string;

	/**
	 * @param path - The refused path.
	 * @param versions - The version expected, the version found, and the last writer.
	 */
	constructor(path: string, versions: { expected: number; actual: number; lastWriter?: string }) {
		super(path);
		this.message = `Refusing to save '${path}': it changed after it was read (version ${versions.expected}, now ${versions.actual}${versions.lastWriter ? `; last writer: ${versions.lastWriter}` : ''}). Read it again, then redo the change.`;
		this.expected = versions.expected;
		this.actual = versions.actual;
		this.lastWriter = versions.lastWriter;
	}
}

/** Persistence seam — implemented by the workspace StagingStore. */
export interface IStagingStore {
	/** Restores persisted layers (null = nothing staged). */
	load(): Promise<Layer[] | null>;
	/** Persists the full layer set (blobs first, manifest last). */
	persist(layers: readonly Layer[]): Promise<void>;
	/** Deletes the entire staging tree (nothing left to persist). */
	sweep(): Promise<void>;
	/**
	 * Best-effort removal of unreferenced blobs. The store derives the
	 * referenced set by scanning its own manifest (content hashes are
	 * computed at persist time and live there, never in the layers).
	 */
	gc(): Promise<void>;
}

/** Construction options. */
export interface StagedFileSystemOptions {
	/**
	 * When true, mutations pass straight through to the base (today's
	 * behavior). Used until every consumer reads through the view, and by
	 * auto-commit mode between checkpoints.
	 */
	writeThrough?: boolean;
	/**
	 * How long a read, readMany or stat waits for the pending mutations of
	 * its paths, and a commit, undo, discard or rollback for the calls
	 * before it, before it fails, in milliseconds (default WAIT_MS). A
	 * backend write that never answers then fails them with a clear error
	 * instead of holding them, and everything queued behind them, forever.
	 */
	waitMs?: number;
	/**
	 * Fired after a STAGED mutation persists (write/rename/delete/mkdir on
	 * the staged branch only — write-through delegates to the base, whose
	 * backend already announces). The composition root uses this to announce
	 * view changes on the host's notification bus, so manual mode's edits
	 * reach the same consumers (dev preview, rescans) as physical writes.
	 */
	onMutate?: (path: string, origin?: string) => void;
	/**
	 * The paths the view refuses to change: throws for one. Runs first in
	 * write, delete, mkdir and both ends of rename, in both modes, before
	 * anything is staged. Manual mode stages without asking the backend, so
	 * a backend-only rule would let a write stage and then fail at commit.
	 */
	assertWritable?: (path: string) => void;
}

/** How long a read or a staging operation waits for the calls before it by default. */
export const WAIT_MS = 60_000;

/** The key of a mutation that holds every path (a discard or a rollback): the root of the tree. */
const ROOT = '';

/** Whether a folder holds a path: the same path, a path below it, or any path when the folder is the root. */
function holds(folder: string, path: string): boolean {
	return folder === ROOT || path === folder || path.startsWith(`${folder}/`);
}

/** How a mutation counts and waits (see StagedFileSystem.mutate). */
interface MutateOptions {
	/** The paths it deletes or moves away, each with everything below it. */
	removed?: readonly string[];
	/** False for a mutation that does not change what the view serves (a commit); it then counts no version. */
	count?: boolean;
	/** What it waits for, instead of the pending mutations of its paths. */
	after?: Promise<unknown>[];
	/** True for a write, delete, rename or mkdir of the view: until it settles, a discard counts its paths, since it lands in the working layer and is dropped. */
	stages?: boolean;
	/** False for a mutation reads need not wait for, since what the view serves is the same before, during and after it (a commit). */
	holdsReads?: boolean;
}

/** A commit or Discard all called and not yet started, and the last staged mutation called before it. */
interface Sweep {
	upTo: number;
}

// =============================================================================
// STAGED FILESYSTEM
// =============================================================================

export class StagedFileSystem implements IWorkspaceFileSystem, WorkspaceFs {
	/** The base view — server truth (plus editor overlays). */
	private readonly base: IWorkspaceBaseView;
	/** Optional persistence; when present, mutations await it before notify. */
	private readonly staging: IStagingStore | null;
	/** Ordered layers, oldest first; last = the mutable working layer. */
	private layerStack: Layer[] = [];
	/** Change-tick listeners (base ticks are re-emitted through this set). */
	private readonly listeners = new Set<() => void>();
	/** Resolves once persisted layers are rehydrated; mutations await it. */
	private readonly ready: Promise<void>;
	/** Pass-through mode flag (see StagedFileSystemOptions). */
	private writeThrough: boolean;
	/** How many mutations each path has seen, by path. */
	private readonly changes = new Map<string, number>();
	/** How many deletes and renames each path has seen; each one also changes every path below it. */
	private readonly removals = new Map<string, number>();
	/** The origin of each path's last mutation, for refusals that name who changed it. */
	private readonly writers = new Map<string, string>();
	/**
	 * How often a discard or rollback dropped each path it had not foreseen
	 * (a commit before it met a conflict, so it did not carry the path), and
	 * so counted it only when it ran: a write called after the discard and
	 * queued behind it passed its version check before that count.
	 */
	private readonly lateDrops = new Map<string, number>();
	/**
	 * How many of this view's changes to the base (a commit's or an undo's
	 * replay, a write-through change) started and finished, by path; a change
	 * of a folder counts for every path below it, and the root's for every
	 * path. A server read that one of them overlapped may hold the file as it
	 * was before it (see readStored). An invalidate counts as one that started
	 * and finished at once: a read on its way may hold the copy it dropped.
	 */
	private readonly baseChanges = new Map<string, { started: number; finished: number }>();
	/** The batch reads of the base on their way, each with the base-change stamp of its paths at its start (see readMany). */
	private readonly batches = new Set<Map<string, number>>();
	/** Each path's pending mutations, as the promise that settles once the last of them has. */
	private readonly chains = new Map<string, Promise<void>>();
	/** The same, without the paths a commit holds: what a read of each path waits for. */
	private readonly readChains = new Map<string, Promise<void>>();
	/** How many writes, deletes, renames and mkdirs of the view were called; each one's number is its place in that order. */
	private mutations = 0;
	/** The writes, deletes, renames and mkdirs still on their way, by number, each with its paths (a commit's or an undo's base calls are not among them). */
	private readonly queued = new Map<number, string[]>();
	/**
	 * The commits and Discard alls called and not yet started. When one
	 * starts it takes every pending layer (a commit carries them to the
	 * server, a discard drops them), with every staged mutation called
	 * before it, so an operation called after it leaves those out of what it
	 * expects to drop.
	 */
	private readonly sweeps = new Set<Sweep>();
	/** The discards and rollbacks waiting for their turn, each with the paths it holds; the wait settles within the time limit. */
	private readonly dropWaits = new Set<{ paths: string[]; waited: Promise<void> }>();
	/** The layers a running commit replays and then sweeps; a write meanwhile opens a new working layer above them. */
	private frozen: ReadonlySet<Layer> | null = null;
	/** Counts changes to the layer stack (a freeze, a checkpoint, a sweep, a drop), so a staged write can tell that its working layer moved while it waited. */
	private shape = 0;
	/** Settles once the last commit, undo, discard, rollback or path discard has; each waits for the one called before it. */
	private turns: Promise<void> = Promise.resolve();
	/** How long a read or a staging operation waits for the calls before it. */
	private readonly waitMs: number;
	/** Staged-mutation announcement hook (see StagedFileSystemOptions). */
	private readonly onMutate: ((path: string, origin?: string) => void) | null;
	/** The read-only rule (see StagedFileSystemOptions). */
	private readonly writableRule: ((path: string) => void) | null;

	/**
	 * Builds the staged view over a base view.
	 *
	 * @param base - The host's workspace view (CachedVfs or another view).
	 * @param staging - Optional persistence store for the layers.
	 * @param options - Behavior flags.
	 */
	constructor(base: IWorkspaceBaseView, staging: IStagingStore | null = null, options: StagedFileSystemOptions = {}) {
		this.base = base;
		this.staging = staging;
		this.writeThrough = options.writeThrough === true;
		this.waitMs = options.waitMs !== undefined && options.waitMs > 0 ? options.waitMs : WAIT_MS;
		this.onMutate = options.onMutate ?? null;
		this.writableRule = options.assertWritable ?? null;
		// step: base ticks flow through our single subscription stream
		this.base.subscribe(() => this.notify());
		// step: rehydrate persisted layers; reads before this resolves see the
		// base. Closes over the PARAMETER: the async IIFE runs inside the
		// constructor, where the property's definite assignment is still open.
		this.ready = (async () => {
			if (!staging) return;
			try {
				const restored = await staging.load();
				if (restored && restored.length > 0) {
					this.layerStack = restored;
					this.notify();
				}
			} catch (err) {
				console.log('[workspace] staging rehydrate failed:', err);
			}
		})();
	}

	/**
	 * Resolves once persisted staged layers are rehydrated. The composition
	 * root awaits this before the first consumer read, so a reloaded page
	 * never briefly shows un-staged base state.
	 *
	 * @returns The rehydration promise (already-resolved when no store).
	 */
	whenReady(): Promise<void> {
		return this.ready;
	}

	// ── Mode control ─────────────────────────────────────────────────────

	/**
	 * Switches pass-through mode. Turning write-through ON with pending
	 * (uncommitted, non-retained) changes is refused — the caller must
	 * commit or discard first (the P3 prompt consumes this error).
	 *
	 * @param on - The new mode.
	 */
	async setWriteThrough(on: boolean): Promise<void> {
		if (on && this.hasPendingChanges()) {
			throw new Error('Cannot enable write-through with uncommitted changes — commit or discard them first.');
		}
		this.writeThrough = on;
	}

	/** Whether any non-retained staged operation exists. */
	hasPendingChanges(): boolean {
		return this.pendingLayers().some((l) => l.entries.size > 0);
	}

	// ── Internals ────────────────────────────────────────────────────────

	/** Canonicalizes a caller path (separators, edge slashes). */
	private norm(path: string): string {
		return String(path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	}

	/** The layers that still contribute to reads/pending state. */
	private pendingLayers(): Layer[] {
		return this.layerStack.filter((l) => !l.committed);
	}

	/**
	 * Memo for effective() rulings, valid for one change tick: listing and
	 * inventory walks call effective() per candidate path (quadratic over
	 * the staged set without this). Cleared by notify() — every layer or
	 * base change flows through that single point.
	 */
	private effectiveCache = new Map<string, LayerEntry | 'gone' | null>();

	/**
	 * The working layer as it stands for a staged mutation: the top layer,
	 * unless it is committed or frozen by a running commit. A mutation called
	 * after a commit that has not started yet does not stage into a layer
	 * that holds what was staged before that commit: it opens one above, so
	 * the commit carries those entries whole (see holdBack).
	 *
	 * @param seq - The mutation's number; 0 for the top layer as it stands.
	 */
	private openLayer(seq = 0): Layer | null {
		const last = this.layerStack[this.layerStack.length - 1];
		if (!last || last.committed || this.frozen?.has(last)) return null;
		const upTo = this.carriedBefore(seq);
		return upTo !== null && [...last.entries.values()].some((entry) => (entry.seq ?? 0) <= upTo) ? null : last;
	}

	/**
	 * The last staged mutation that the commits and Discard alls waiting to
	 * start, called before mutation `seq`, take along. It is 0 for one called
	 * before any staged mutation of this page: it still takes the entries the
	 * page restored, which have no number.
	 *
	 * @param seq - The mutation's number.
	 * @returns Its number, or null when none waits.
	 */
	private carriedBefore(seq: number): number | null {
		const upTos = [...this.sweeps].map((sweep) => sweep.upTo).filter((upTo) => upTo < seq);
		return upTos.length > 0 ? Math.max(...upTos) : null;
	}

	/** Counts a commit or Discard all in among the ones waiting to start, or out; a staged write captures again (see captureBelow). */
	private waiting(sweep: Sweep, on: boolean): void {
		if (on ? this.sweeps.has(sweep) : !this.sweeps.has(sweep)) return;
		if (on) this.sweeps.add(sweep);
		else this.sweeps.delete(sweep);
		this.shape += 1;
	}

	/**
	 * The mutable working layer, created on first staged mutation.
	 *
	 * @param seq - The staging mutation's number (see openLayer).
	 */
	private workingLayer(seq = 0): Layer {
		const open = this.openLayer(seq);
		if (open) return open;
		const layer: Layer = { id: crypto.randomUUID(), label: 'Working', entries: new Map() };
		this.layerStack.push(layer);
		return layer;
	}

	/**
	 * The decisive staged answer for a path, newest pending layer first.
	 * Checks the exact path, then ancestors in the same layer (a tombstoned
	 * or file-overwritten ancestor hides everything beneath it).
	 *
	 * @param path - Canonical path.
	 * @returns The entry, 'gone' when shadowed/deleted, or null (ask base).
	 */
	private effective(path: string): LayerEntry | 'gone' | null {
		const memo = this.effectiveCache.get(path);
		if (memo !== undefined) return memo;
		const ruling = this.effectiveUncached(path);
		this.effectiveCache.set(path, ruling);
		return ruling;
	}

	/** effective()'s actual walk, over the pending layers or the ones given (a commit's frozen layers). */
	private effectiveUncached(path: string, layers?: readonly Layer[]): LayerEntry | 'gone' | null {
		const pending = layers ?? this.pendingLayers();
		for (let i = pending.length - 1; i >= 0; i--) {
			const layer = pending[i];
			const exact = layer.entries.get(path);
			if (exact) return exact.kind === 'tombstone' ? 'gone' : exact;
			// step: ancestor rulings in this layer shadow deeper paths
			for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
				const ancestor = layer.entries.get(path.slice(0, cut));
				if (ancestor && (ancestor.kind === 'tombstone' || ancestor.kind === 'write')) return 'gone';
			}
		}
		return null;
	}

	/** Whether any pending staged entry exists strictly below a path. */
	private hasStagedDescendant(path: string): boolean {
		const prefix = `${path}/`;
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				if (p.startsWith(prefix) && this.effective(p) !== 'gone' && this.effective(p) !== null) return true;
			}
		}
		return false;
	}

	/**
	 * The content effective BELOW the working layer for a path — what a new
	 * working-layer entry must capture as its `before`.
	 *
	 * @param path - Canonical path.
	 * @param seq - The staging mutation's number (see openLayer).
	 * @returns Content string, or null when the path has no file below.
	 */
	private async effectiveBefore(path: string, seq = 0): Promise<string | null> {
		// step: an existing working-layer entry already carries the capture
		const own = this.openLayer(seq)?.entries.get(path);
		if (own && own.kind !== 'mkdir') return own.before;
		if (own && own.kind === 'mkdir') return null;
		// step: otherwise the current effective view IS the below-state
		const eff = this.effective(path);
		if (eff === 'gone') return null;
		if (eff && eff.kind === 'write') return eff.content;
		if (eff && eff.kind === 'mkdir') return null;
		try {
			// step: the server's copy this page read, which every reader of the path was served, else the
			// server's copy now. Never a dirty overlay: the base view serves an open editor's buffer from
			// read(), and capturing that as "before" would make staging the same buffer a silent no-op.
			// When the server's copy moved on since the page read it (another tab, a teammate), the
			// commit then meets a conflict instead of writing over a change no one here saw
			const cached = this.base.cachedContent(path);
			const content = cached !== undefined ? cached : await this.base.peekBase(path);
			return typeof content === 'string' ? content : null;
		} catch {
			return null;
		}
	}

	/** Persists layers (when a store exists), then fires the change tick. */
	private async persistAndNotify(): Promise<void> {
		// step: the layers already changed — reads during the persist await
		// must not be served from the pre-change memo
		this.effectiveCache.clear();
		if (this.staging) {
			// step: persistence IS the save — the tick waits for it
			await this.staging.persist(this.layerStack);
		}
		this.notify();
	}

	/** Best-effort GC — failures only leave orphans for the next load(). */
	private async gcBestEffort(): Promise<void> {
		if (!this.staging) return;
		try {
			await this.staging.gc();
		} catch {
			/* orphans are harmless; load() sweeps authoritatively */
		}
	}

	// ── Path versions ────────────────────────────────────────────────────

	/** The path's version: its own mutations, plus every delete or rename of a folder above it. */
	version(path: string): number {
		const p = this.norm(path);
		let version = this.changes.get(p) ?? 0;
		for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
			version += this.removals.get(p.slice(0, cut)) ?? 0;
		}
		return version;
	}

	/** Who changed the path last, or the folder above it that was deleted or renamed last. */
	lastWriter(path: string): string | undefined {
		const p = this.norm(path);
		if (this.writers.has(p)) return this.writers.get(p);
		for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
			const folder = p.slice(0, cut);
			if (this.removals.has(folder)) return this.writers.get(folder);
		}
		return undefined;
	}

	/** How many late drops (see lateDrops) a path has seen, its own and those of the folders above it. */
	private lateDropsOf(p: string): number {
		let late = this.lateDrops.get(p) ?? 0;
		for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) late += this.lateDrops.get(p.slice(0, cut)) ?? 0;
		return late;
	}

	/**
	 * Counts one mutation of a path and records who made it.
	 *
	 * @param p - Canonical path.
	 * @param origin - The writer's identity; none forgets the last one.
	 * @param removal - True for a delete or rename, which changes every path below too.
	 */
	private count(p: string, origin: string | undefined, removal = false): void {
		this.changes.set(p, (this.changes.get(p) ?? 0) + 1);
		if (removal) this.removals.set(p, (this.removals.get(p) ?? 0) + 1);
		if (origin) this.writers.set(p, origin);
		else this.writers.delete(p);
	}

	/**
	 * The pending mutations a call on a path waits for: the path's own, those
	 * of the folders above it (a discard or rollback holds the root, so every
	 * path), and for a mutation those of every path below. A read does not
	 * wait for a commit.
	 *
	 * @param p - Canonical path; the root for a call on every path.
	 * @param below - Include the paths below (mutations take them along).
	 * @param read - For a read: leave out the paths a commit holds.
	 * @returns Each pending mutation's path and promise.
	 */
	private pendingOn(p: string, below: boolean, read = false): Array<[string, Promise<void>]> {
		const out: Array<[string, Promise<void>]> = [];
		for (const [chained, chain] of read ? this.readChains : this.chains) {
			if (holds(chained, p) || (below && holds(p, chained))) out.push([chained, chain]);
		}
		return out;
	}

	/**
	 * Runs one mutation in its turn. Its paths are counted now, in the
	 * caller's synchronous block, so whoever read them before is stale from
	 * this moment; the work starts once every pending mutation of its paths
	 * has settled, or once what `opts.after` names has. A mutation that fails
	 * counts again, since what it left behind is unknown. Every later call on
	 * its paths waits for it.
	 *
	 * @param paths - The canonical paths it changes.
	 * @param origin - The writer's identity.
	 * @param work - The mutation itself, given its number among the view's staged mutations (0 for any other).
	 * @param opts - What it removes, whether it counts, what it waits for, and whether reads wait for it.
	 * @returns The work's promise.
	 */
	private mutate<T>(paths: string[], origin: string | undefined, work: (seq: number) => Promise<T>, opts: MutateOptions = {}): Promise<T> {
		const own = [...new Set(paths)];
		const removed = new Set(opts.removed);
		const counts = opts.count !== false;
		const before = opts.after ?? own.flatMap((p) => this.pendingOn(p, true).map(([, chain]) => chain));
		if (counts) for (const p of own) this.count(p, origin, removed.has(p));
		const id = opts.stages ? ++this.mutations : 0;
		if (opts.stages) this.queued.set(id, own);
		const run = Promise.all(before).then(() => work(id));
		const tail = run.then(
			() => undefined,
			() => {
				if (counts) for (const p of own) this.count(p, origin, removed.has(p));
			}
		);
		if (opts.stages) void tail.then(() => this.queued.delete(id));
		for (const p of own) {
			this.chain(this.chains, p, tail, opts.after !== undefined);
			if (opts.holdsReads !== false) this.chain(this.readChains, p, tail, opts.after !== undefined);
		}
		return run;
	}

	/**
	 * Puts a mutation at the end of a path's chain.
	 *
	 * @param chains - The chains (every mutation's, or the ones reads wait for).
	 * @param p - Canonical path.
	 * @param tail - Settles once the mutation has.
	 * @param keep - True for a mutation that did not wait for the path's earlier ones (opts.after): the chain keeps them.
	 */
	private chain(chains: Map<string, Promise<void>>, p: string, tail: Promise<void>, keep: boolean): void {
		const earlier = chains.get(p);
		const chain = earlier && keep ? Promise.all([earlier, tail]).then(() => undefined) : tail;
		chains.set(p, chain);
		void chain.then(() => {
			if (chains.get(p) === chain) chains.delete(p);
		});
	}

	/**
	 * Waits for some pending calls, up to the time limit. A backend call that
	 * never answers then fails the waiting operation with a clear error, and
	 * whatever is queued behind it goes on.
	 *
	 * @param what - What the operation is, for the error ('commit').
	 * @param waits - What it waits for: each pending mutation's path, or null for the staging operation called before it.
	 */
	private async waitInTurn(what: string, waits: Array<[string | null, Promise<unknown>]>): Promise<void> {
		const open = new Set(waits);
		for (const wait of waits) void wait[1].then(() => open.delete(wait));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const [path] = [...open][0] ?? [null];
				const blocking = path === null ? 'a commit, undo or discard called before it is still running' : `a change to ${path} is still on its way to the server`;
				reject(new Error(`Could not ${what}: ${blocking} after ${this.waitMs / 1000} s. Try again later; if this keeps happening, the server is not answering.`));
			}, this.waitMs);
		});
		try {
			await Promise.race([Promise.all(waits.map(([, wait]) => wait)), limit]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Runs a commit or an undo in its turn: after the staging operation
	 * called before it and after every mutation called before it, waiting
	 * for them up to the time limit.
	 *
	 * @param what - What the operation is, for the error when the wait runs out.
	 * @param work - The operation.
	 * @returns The work's promise.
	 */
	private inTurn<T>(what: string, work: () => Promise<T>): Promise<T> {
		const run = this.waitInTurn(what, [[null, this.turns], ...this.chains]).then(work);
		this.turns = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	/**
	 * Drops staged changes in their turn, as a mutation of some paths (the
	 * root for every path): after the staging operation called before it and
	 * every mutation of those paths called before it (waiting for them up to
	 * the time limit), and before every later mutation and read of them. The
	 * paths it is about to drop are counted now. A path it drops that was not
	 * foreseen (a commit before it failed, so the commit's layers stayed) is
	 * counted when it is dropped.
	 *
	 * @param paths - The paths it holds.
	 * @param foreseen - What it will drop, as known now: each path, and whether it was staged as deleted.
	 * @param drop - Changes the layers, then returns what it dropped and the persistence that follows.
	 * @param what - What the operation is, for the error when the wait runs out.
	 * @returns The drop's promise.
	 */
	private dropInTurn(paths: string[], foreseen: Map<string, boolean>, drop: () => { dropped: Map<string, boolean>; settle: () => Promise<void> }, what: string): Promise<void> {
		for (const [p, removal] of foreseen) this.count(p, 'discard', removal);
		const waited = this.waitInTurn(what, [[null, this.turns], ...paths.flatMap((p) => this.pendingOn(p, true))]);
		const waiting = { paths, waited: waited.catch(() => undefined) };
		this.dropWaits.add(waiting);
		void waiting.waited.then(() => this.dropWaits.delete(waiting));
		const run = this.mutate(
			paths,
			'discard',
			async () => {
				await this.ready;
				const { dropped, settle } = drop();
				this.shape += 1;
				for (const [p, removal] of dropped) {
					if (foreseen.has(p)) continue;
					this.count(p, 'discard', removal);
					this.lateDrops.set(p, (this.lateDrops.get(p) ?? 0) + 1);
				}
				await settle();
			},
			{ count: false, after: [waited] }
		);
		this.turns = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	/**
	 * What dropping some layers would take out of the view: each staged path,
	 * and whether it was staged as deleted. Layers a running commit froze are
	 * left out, since the commit is expected to carry them to the server. So
	 * is everything a commit or Discard all waiting to start will take: every
	 * staged mutation called before it, wherever it landed. What a mutation
	 * called after it staged stays (see holdBack), so it counts.
	 *
	 * @param layers - The layers to drop.
	 * @param queued - Also the paths of mutations still on their way, which land in the working layer first.
	 */
	private staged(layers: readonly Layer[], queued: boolean): Map<string, boolean> {
		const out = new Map<string, boolean>();
		const taken = Math.max(0, ...[...this.sweeps].map((sweep) => sweep.upTo));
		for (const layer of layers) {
			if (this.frozen?.has(layer)) continue;
			for (const [p, entry] of layer.entries) {
				if (this.sweeps.size > 0 && (entry.seq ?? 0) <= taken) continue;
				out.set(p, out.get(p) === true || entry.kind === 'tombstone');
			}
		}
		// step: a queued mutation may be a delete, so its path counts as one (that only reaches
		// paths below it). A running commit's held paths are not queued: it carries them to the server
		if (queued && !this.writeThrough) {
			for (const [id, paths] of this.queued) if (id > taken) for (const p of paths) out.set(p, true);
		}
		return out;
	}

	/**
	 * Each staged path of some layers, and whether it was staged as deleted.
	 *
	 * @param layers - The dropped layers.
	 */
	private entriesOf(layers: readonly Layer[]): Map<string, boolean> {
		const out = new Map<string, boolean>();
		for (const layer of layers) for (const [p, entry] of layer.entries) out.set(p, out.get(p) === true || entry.kind === 'tombstone');
		return out;
	}

	/**
	 * Waits for the pending mutations of some paths before a read, up to the
	 * time limit, so a backend write that never answers fails the read with a
	 * clear error instead of holding it forever. A commit is not waited for:
	 * the view serves the same content during it. What it waits for is taken
	 * when it is called. A discard or rollback ahead of it that is still
	 * waiting for its turn gives up within its own time limit, so the read's
	 * limit starts once that wait is over: a write queued behind a discard
	 * that gave up then lands before the read gives up too.
	 *
	 * @param paths - Canonical paths.
	 */
	private async waitToRead(paths: string[]): Promise<void> {
		const waiting = paths.filter((p) => this.pendingOn(p, false, true).length > 0);
		if (waiting.length === 0) return;
		const pending = waiting.flatMap((p) => this.pendingOn(p, false, true).map(([, chain]) => chain));
		const drops = [...this.dropWaits].filter((drop) => drop.paths.some((held) => waiting.some((p) => holds(held, p))));
		if (drops.length > 0) await Promise.all(drops.map((drop) => drop.waited));
		const name = waiting.length === 1 ? waiting[0] : `${waiting[0]} (and ${waiting.length - 1} more)`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Could not read ${name}: a change to it is still on its way to the server after ${this.waitMs / 1000} s. Try again later; if this keeps happening, the server is not answering.`)), this.waitMs);
		});
		try {
			await Promise.race([Promise.all(pending), limit]);
		} finally {
			clearTimeout(timer);
		}
	}

	// ── IVirtualFileSystem — reads ───────────────────────────────────────

	/** Lists one directory as the staged union over the base. */
	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		await this.ready;
		const d = this.norm(dir);

		// step: base contribution (a dir may exist only in layers)
		let baseEntries: { name: string; type: 'file' | 'dir' }[] = [];
		try {
			baseEntries = await this.base.list(d);
		} catch {
			baseEntries = [];
		}

		// step: candidate child names = base names + staged direct children
		const candidates = new Map<string, 'file' | 'dir'>();
		for (const e of baseEntries) candidates.set(e.name, e.type);
		const prefix = d ? `${d}/` : '';
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				if (!p.startsWith(prefix) || p === d) continue;
				const rest = p.slice(prefix.length);
				const name = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
				if (!candidates.has(name)) candidates.set(name, 'dir');
			}
		}

		// step: rule each candidate through the effective view
		const out: { name: string; type: 'file' | 'dir' }[] = [];
		for (const [name, baseType] of candidates) {
			const full = prefix + name;
			const eff = this.effective(full);
			if (eff === 'gone') continue;
			if (eff && eff.kind === 'write') { out.push({ name, type: 'file' }); continue; }
			if (eff && eff.kind === 'mkdir') { out.push({ name, type: 'dir' }); continue; }
			if (baseEntries.some((e) => e.name === name)) { out.push({ name, type: baseType }); continue; }
			// step: implied directory — staged entries exist deeper down
			if (this.hasStagedDescendant(full)) out.push({ name, type: 'dir' });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Reads one file once its pending mutations have settled. */
	async read(path: string): Promise<unknown> {
		return (await this.readVersioned(path)).content;
	}

	/** read() plus its version, taken at the call; the read waits for the path's pending mutations, up to the read time limit. With `stored`, no editor's unsaved buffer answers it. */
	readVersioned(path: string, opts: { stored?: boolean } = {}): Promise<{ content: unknown; version: number }> {
		const p = this.norm(path);
		const version = this.version(p);
		return this.waitToRead([p]).then(async () => ({ content: await this.readNow(p, opts.stored === true), version }));
	}

	/**
	 * Reads one file now: dirty overlay, then staged layers, then base.
	 *
	 * @param p - Canonical path.
	 * @param stored - Skip the dirty overlay: what the view stores, as read() would serve it with no editor open.
	 */
	private async readNow(p: string, stored = false): Promise<unknown> {
		await this.ready;
		// step: a dirty editor buffer is the user's live truth — it wins
		if (!stored && this.base.isDirty(p)) return this.base.read(p);
		const eff = this.effective(p);
		if (eff === 'gone') throw new Error(`No such file: ${p}`);
		if (eff && eff.kind === 'write') return eff.content;
		if (eff && eff.kind === 'mkdir') throw new Error(`Not a file: ${p}`);
		return this.readStored(p);
	}

	/**
	 * What the base stores for a file: its cached copy, else the server's,
	 * which becomes the cached copy, as the base's read() would make it. A
	 * server read that one of this view's changes to the base overtook may
	 * hold the file as it was before the change, so it is taken again. One
	 * that ran while a change was on its way is returned but not cached: the
	 * change leaves its own content in the cache. The cached copy is not
	 * taken while a batch read that a change overtook may still replace it.
	 *
	 * @param p - Canonical path.
	 */
	private async readStored(p: string): Promise<unknown> {
		for (;;) {
			const cached = this.overtakenBatch(p) ? undefined : this.base.cachedContent(p);
			if (cached !== undefined) return cached;
			const before = this.baseStamp(p).stamp;
			let content: unknown;
			try {
				content = await this.base.peekBase(p);
			} catch (err) {
				if (this.baseStamp(p).stamp !== before) continue;
				throw err;
			}
			const after = this.baseStamp(p);
			if (after.stamp !== before) continue;
			if (!after.changing && !this.overtakenBatch(p)) this.base.prime(p, content);
			return content;
		}
	}

	/**
	 * Changes some paths on the base, counted (see baseChanges), so a server
	 * read of one of them that the change overtakes is taken again.
	 *
	 * @param paths - Canonical paths it changes, each with everything below it.
	 * @param change - The base call.
	 * @returns The call's promise.
	 */
	private async changeBase<T>(paths: string[], change: () => Promise<T>): Promise<T> {
		const counts = paths.map((p) => {
			let count = this.baseChanges.get(p);
			if (!count) this.baseChanges.set(p, (count = { started: 0, finished: 0 }));
			return count;
		});
		for (const count of counts) count.started += 1;
		try {
			return await change();
		} finally {
			for (const count of counts) count.finished += 1;
		}
	}

	/**
	 * This view's changes to the base at a path and above it: a stamp that
	 * moves when one starts or finishes, and whether one is on its way.
	 *
	 * @param p - Canonical path.
	 */
	private baseStamp(p: string): { stamp: number; changing: boolean } {
		let [started, finished] = [0, 0];
		for (let at = p; ; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
			const count = this.baseChanges.get(at);
			if (count) [started, finished] = [started + count.started, finished + count.finished];
			if (at === ROOT) break;
		}
		return { stamp: started + finished, changing: started !== finished };
	}

	/**
	 * Whether a batch read on its way holds a path that a change to the base
	 * overtook: the base may still cache the file as the batch found it.
	 *
	 * @param p - Canonical path.
	 */
	private overtakenBatch(p: string): boolean {
		for (const batch of this.batches) {
			const at = batch.get(p);
			if (at === undefined) continue;
			const now = this.baseStamp(p);
			if (now.stamp !== at || now.changing) return true;
		}
		return false;
	}

	/**
	 * Reads many files in one call, each resolved through the staged view
	 * exactly like read(); unreadable paths (staged-deleted, missing) are
	 * OMITTED rather than failing the batch.
	 *
	 * @param paths - Paths to read.
	 * @returns Map of path to content for every readable path.
	 */
	async readMany(paths: string[]): Promise<Record<string, unknown>> {
		await this.waitToRead(paths.map((path) => this.norm(path)));
		await this.ready;
		const out: Record<string, unknown> = {};
		const passthrough: string[] = [];
		for (const path of paths) {
			const p = this.norm(path);
			// step: dirty overlays and staged rulings answer locally; only
			// the remainder rides the base's batch (one round trip there)
			if (this.base.isDirty(p)) { out[path] = await this.base.read(p); continue; }
			const eff = this.effective(p);
			if (eff === 'gone') continue;
			if (eff && eff.kind === 'write') { out[path] = eff.content; continue; }
			if (eff && eff.kind === 'mkdir') continue;
			passthrough.push(path);
		}
		if (passthrough.length > 0) {
			// step: the base caches what its batch reads. A path that a change to the base overtook
			// meanwhile is dropped from the cache before the batch stops guarding it, and read again
			const batch = new Map(passthrough.map((path) => [this.norm(path), this.baseStamp(this.norm(path)).stamp]));
			this.batches.add(batch);
			const settle = (): string[] => {
				const overtaken = passthrough.filter((path) => this.overtakenBatch(this.norm(path)));
				for (const path of overtaken) this.base.invalidate(path);
				this.batches.delete(batch);
				return overtaken;
			};
			let found: Record<string, unknown>;
			try {
				found = await this.base.readMany(passthrough);
			} catch (err) {
				settle();
				throw err;
			}
			const overtaken = settle();
			for (const [path, content] of Object.entries(found)) if (!overtaken.includes(path)) out[path] = content;
			await Promise.all(
				overtaken.map(async (path) => {
					try {
						out[path] = await this.readStored(this.norm(path));
					} catch {
						/* unreadable: omitted, as from the batch */
					}
				})
			);
		}
		return out;
	}

	/**
	 * The type of a path, consulting the base backend when neither the
	 * staged layers nor the cached inventory can answer.
	 *
	 * @param path - Path to classify.
	 * @returns 'file' | 'dir', or null when the path does not exist.
	 */
	async stat(path: string): Promise<'file' | 'dir' | null> {
		const p = this.norm(path);
		await this.waitToRead([p]);
		return this.statNow(p);
	}

	/** stat() now, for mutations that already hold their turn. */
	private async statNow(p: string): Promise<'file' | 'dir' | null> {
		await this.ready;
		const known = this.entryType(p);
		if (known) return known;
		// step: a staged ruling of 'gone' is final — never ask the base
		if (this.effective(p) === 'gone') return null;
		return this.base.stat(p);
	}

	// ── IVirtualFileSystem — mutations (staged) ──────────────────────────

	/**
	 * Throws when the view refuses changes to a path — the same rule every
	 * mutation runs first, so a caller can refuse before it asks the user.
	 *
	 * @param path - The path a change would touch.
	 */
	assertWritable(path: string): void {
		this.writableRule?.(this.norm(path));
	}

	/**
	 * assertWritable for a mutation that returns its promise: the refusal
	 * becomes a rejection, as an async method's throw would.
	 *
	 * @param paths - The paths the mutation would touch.
	 * @returns A rejected promise for the first refused path, else null.
	 */
	private refuseUnwritable(...paths: string[]): Promise<never> | null {
		try {
			for (const path of paths) this.assertWritable(path);
			return null;
		} catch (err) {
			return Promise.reject(err);
		}
	}

	/**
	 * Verifies the base has not moved under a path since it was read — the
	 * freshness gate every write-through save passes. Baseline = the base
	 * view's cached content (what the buffer was opened from); current =
	 * a cache-preserving backend peek. Equal hashes (or both absent — a new
	 * file) pass; anything else refuses with StaleWriteError and leaves the
	 * baseline UNTOUCHED, so a blind retry refuses again — exactly VS Code's
	 * behavior. Resolution is the caller's: re-read (adopts the new base as
	 * baseline) then re-save to overwrite deliberately, or revert.
	 *
	 * @param p - The normalized path about to be written.
	 */
	private async guardFreshBase(p: string): Promise<void> {
		const baseline = this.base.cachedContent(p);
		let current: unknown;
		try {
			current = await this.base.peekBase(p);
		} catch {
			current = undefined; // does not exist on the base
		}
		if (baseline === undefined && current === undefined) return; // new file
		if (baseline !== undefined && current !== undefined) {
			const [a, b] = await Promise.all([sha256Hex(String(baseline)), sha256Hex(String(current))]);
			if (a === b) return;
		}
		throw new StaleWriteError(p);
	}

	/**
	 * Stages a whole-file write (or passes through in write-through mode). With
	 * `expect`, the write is refused unless the path is still at that version,
	 * and when a discard called before it drops the path only once it runs.
	 * A read-only path is refused first, before the version check.
	 */
	write(path: string, content: unknown, origin?: string, expect?: number): Promise<void> {
		const refused = this.refuseUnwritable(path);
		if (refused) return refused;
		const p = this.norm(path);
		// step: the version check, the count and the queueing run in one synchronous
		// block, so nothing can change the path between the check and the count
		if (expect !== undefined && expect !== this.version(p)) {
			return Promise.reject(new StaleVersionError(p, { expected: expect, actual: this.version(p), lastWriter: this.lastWriter(p) }));
		}
		const late = this.lateDropsOf(p);
		return this.mutate(
			[p],
			origin,
			(seq) => {
				// step: a discard called before it dropped the path after all, after the check above: the content may be computed from what it dropped
				if (expect !== undefined && this.lateDropsOf(p) !== late) throw new StaleVersionError(p, { expected: expect, actual: this.version(p), lastWriter: this.lastWriter(p) });
				return this.writeNow(p, content, origin, seq);
			},
			{ stages: true }
		);
	}

	/** write() in its turn; `seq` is the mutation's number. */
	private async writeNow(p: string, content: unknown, origin?: string, seq?: number): Promise<void> {
		await this.ready;
		if (this.writeThrough) {
			// step: write-through IS the commit for this path — same freshness
			// discipline commit() applies to staged layers, at save time.
			await this.guardFreshBase(p);
			return this.changeBase([p], () => this.base.write(p, content, origin));
		}
		if (typeof content !== 'string') {
			throw new Error(`Staged writes are text-only: ${p}`);
		}
		// step: first touch captures the conflict anchor; later touches keep it
		// (an entry the working layer already has carries it)
		const { before: keepBefore, baseHash } = await this.captureBelow(p, seq);
		// step: from the capture to the entry nothing awaits, so the layer
		// chosen here is the one the capture was taken for
		const layer = this.workingLayer(seq);
		const prior = layer.entries.get(p);
		// step: a write landing EXACTLY on the below-state is not a change —
		// drop the round-trip entry (save, undo, save-again leaves no residue,
		// exactly git's clean status after a revert). keepBefore IS what reads
		// resolve to once the entry is gone, so deletion is content-neutral.
		if (typeof keepBefore === 'string' && content === keepBefore) {
			if (!prior) return; // no-op save of unchanged content — nothing to stage
			layer.entries.delete(p);
			await this.persistAndNotify();
			// step: the view's content changed (back to the below-state)
			this.onMutate?.(p, origin);
			return;
		}
		layer.entries.set(p, { kind: 'write', content, before: keepBefore, baseHash, stamp: Date.now(), seq });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	/**
	 * What a new working-layer entry for a path captures: the content below
	 * the working layer and its hash. A freeze, checkpoint or drop while it
	 * waits moves the working layer, and so does a commit called or started,
	 * so it captures again; the caller sets its entry in the same synchronous
	 * block as the last check.
	 *
	 * @param p - Canonical path.
	 * @param seq - The staging mutation's number (see openLayer).
	 * @returns The capture.
	 */
	private async captureBelow(p: string, seq = 0): Promise<{ before: string | null; baseHash: string | null }> {
		for (;;) {
			const shape = this.shape;
			const before = await this.effectiveBefore(p, seq);
			const baseHash = before === null ? null : await sha256Hex(before);
			if (shape === this.shape) return { before, baseHash };
		}
	}

	/**
	 * Stages a delete (tombstone); directories drop their staged subtree.
	 *
	 * @param path - The target.
	 * @param originOrRecursive - A string = the vfs-layer write ORIGIN (echo
	 *   suppression); a boolean = the WorkspaceFs contract recursive flag,
	 *   which a staged delete does not need (subtrees are shadowed anyway).
	 */
	delete(path: string, originOrRecursive?: string | boolean): Promise<void> {
		const refused = this.refuseUnwritable(path);
		if (refused) return refused;
		const origin = typeof originOrRecursive === 'string' ? originOrRecursive : undefined;
		const p = this.norm(path);
		return this.mutate([p], origin, (seq) => this.deleteNow(p, origin, seq), { removed: [p], stages: true });
	}

	/** delete() in its turn; `seq` is the mutation's number. */
	private async deleteNow(p: string, origin?: string, seq?: number): Promise<void> {
		await this.ready;
		if (this.writeThrough) return this.changeBase([p], () => this.base.delete(p, origin));
		if (!p) throw new Error('Refusing to delete the workspace root.');
		// step: rule on the path's KIND first — a missing path is an error,
		// not an invisible forever-pending entry. The dir flag records that
		// the BASE has the directory (a staged-only dir nets to nothing);
		// dirs have no content capture, so existence is their commit anchor
		const kind = await this.statNow(p);
		if (kind === null) throw new Error(`No such path: ${p}`);
		const baseKind = kind === 'dir' ? await this.base.stat(p) : null;
		const { before: keepBefore, baseHash } = await this.captureBelow(p, seq);
		// step: nothing awaits from the capture to the entry (see writeNow)
		const layer = this.workingLayer(seq);
		// step: staged entries under a deleted directory are swallowed by it
		const prefix = `${p}/`;
		for (const key of [...layer.entries.keys()]) {
			if (key.startsWith(prefix)) layer.entries.delete(key);
		}
		layer.entries.set(p, { kind: 'tombstone', before: keepBefore, baseHash, dir: baseKind === 'dir', stamp: Date.now(), seq });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	/**
	 * Stages a file rename as tombstone + write (dirs: commit first). A rename
	 * is refused while an editor holds unsaved changes at or under its source:
	 * the editor, its overlay and the agent's question about it stay on the
	 * old path, and a staged rename would write the unsaved text as the new
	 * file.
	 */
	rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
		const refused = this.refuseUnwritable(oldPath, newPath);
		if (refused) return refused;
		const from = this.norm(oldPath);
		const to = this.norm(newPath);
		const unsaved = [...this.base.dirtyPaths()].find((p) => holds(from, p));
		if (unsaved !== undefined) return Promise.reject(new Error(`Save or discard the unsaved changes in ${unsaved} first.`));
		return this.mutate([from, to], origin, (seq) => this.renameNow(from, to, origin, seq), { removed: [from], stages: true });
	}

	/** rename() in its turn; `seq` is the mutation's number. */
	private async renameNow(from: string, to: string, origin?: string, seq?: number): Promise<void> {
		await this.ready;
		if (this.writeThrough) return this.changeBase([from, to], () => this.base.rename(from, to, origin));
		// step: a definitive ruling — stat consults the base backend when
		// the inventory has not been walked, so the guard actually holds
		const type = await this.statNow(from);
		if (type === 'dir') {
			throw new Error(`Staged directory renames are not supported yet — commit first, then rename ${from}.`);
		}
		const content = await this.readNow(from);
		if (typeof content !== 'string') throw new Error(`Staged renames are text-only: ${from}`);
		// step: origin rides both halves — each announces through onMutate,
		// matching the backend's both-ends announcement for physical renames
		await this.deleteNow(from, origin, seq);
		await this.writeNow(to, content, origin, seq);
	}

	/**
	 * Stages a directory creation. Creating a directory that already exists
	 * (in the base or staged) is a NO-OP rather than a staged entry, so
	 * changedPaths()/undo never report an "added" directory that was
	 * actually there all along.
	 */
	mkdir(path: string, origin?: string): Promise<void> {
		const refused = this.refuseUnwritable(path);
		if (refused) return refused;
		const p = this.norm(path);
		return this.mutate([p], origin, (seq) => this.mkdirNow(p, origin, seq), { stages: true });
	}

	/** mkdir() in its turn; `seq` is the mutation's number. */
	private async mkdirNow(p: string, origin?: string, seq?: number): Promise<void> {
		await this.ready;
		if (this.writeThrough) return this.base.mkdir(p, origin);
		if (!p) return;
		const existing = await this.statNow(p);
		if (existing === 'dir') return;
		if (existing === 'file') throw new Error(`Not a directory: ${p}`);
		this.workingLayer(seq).entries.set(p, { kind: 'mkdir', stamp: Date.now(), seq });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	// ── IWorkspaceFileSystem — view surface ──────────────────────────────

	/** Re-walks the base inventory. */
	refresh(): Promise<void> {
		return this.base.refresh();
	}

	/** The staged union of the base inventory and layer-created paths. */
	listEntries(): VfsEntry[] {
		const out = new Map<string, 'file' | 'dir'>();
		// step: base inventory, minus staged-gone paths
		for (const e of this.base.listEntries()) {
			if (this.effective(e.path) !== 'gone') out.set(e.path, e.type);
		}
		// step: staged creations (and their implicit parent dirs)
		for (const layer of this.pendingLayers()) {
			for (const [p, entry] of layer.entries) {
				const eff = this.effective(p);
				if (eff === 'gone' || eff === null) continue;
				if (entry.kind === 'write') out.set(p, 'file');
				if (entry.kind === 'mkdir') out.set(p, 'dir');
				for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
					const parent = p.slice(0, cut);
					if (!out.has(parent)) out.set(parent, 'dir');
				}
			}
		}
		return [...out.entries()].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
	}

	/** The staged kind of a path. */
	entryType(path: string): 'file' | 'dir' | null {
		const p = this.norm(path);
		const eff = this.effective(p);
		if (eff === 'gone') return null;
		if (eff && eff.kind === 'write') return 'file';
		if (eff && eff.kind === 'mkdir') return 'dir';
		const baseType = this.base.entryType(p);
		if (baseType) return baseType;
		return this.hasStagedDescendant(p) ? 'dir' : null;
	}

	/** Inventory seed — delegates to the base. */
	upsert(path: string, type: 'file' | 'dir'): void {
		this.base.upsert(path, type);
	}

	/**
	 * Content-cache seed, declined: the base's cache holds only the server's
	 * copy, which an editor reloads and the commit's conflict check starts
	 * from. What a caller hands back came through this view, so it may be an
	 * editor's unsaved buffer or staged content (the dev preview primes what
	 * its batch read returned). The view's own reads cache the server's copy
	 * already (readStored, the base's batch). Only the inventory takes the
	 * path, when nothing knows it yet.
	 *
	 * @param path - The path to seed.
	 * @param _content - Not cached.
	 */
	prime(path: string, _content: unknown): void {
		const p = this.norm(path);
		if (this.entryType(p) === null) this.base.upsert(p, 'file');
	}

	/**
	 * Content-cache eviction — delegates to the base. A server read of the
	 * path on its way may come back with the copy being dropped, so it counts
	 * as overtaken, like a change to the base: readStored takes it again and
	 * does not cache it, and a batch read drops what it cached.
	 *
	 * @param path - The path to evict; omit to clear the whole cache.
	 */
	invalidate(path?: string): void {
		const p = path === undefined ? ROOT : this.norm(path);
		let count = this.baseChanges.get(p);
		if (!count) this.baseChanges.set(p, (count = { started: 0, finished: 0 }));
		count.started += 1;
		count.finished += 1;
		this.base.invalidate(path === undefined ? undefined : p);
	}

	/** Editor overlays live on the base (one registry for all views). */
	registerOverlay(path: string, overlay: VfsOverlay): () => void {
		return this.base.registerOverlay(this.norm(path), overlay);
	}

	/** The base view's cached baseline content (freshness-gate anchor). */
	cachedContent(path: string): unknown {
		return this.base.cachedContent(this.norm(path));
	}

	/**
	 * What the view holds for a path under any editor overlay, with no
	 * backend read: the staged content, else the base view's cached content.
	 * Lets a writer skip a write the view already holds.
	 *
	 * @param path - The path to look up.
	 * @returns The content; undefined when neither is known, or the path is staged as deleted or as a folder.
	 */
	heldContent(path: string): unknown {
		const p = this.norm(path);
		const eff = this.effective(p);
		if (eff === null) return this.base.cachedContent(p);
		return eff !== 'gone' && eff.kind === 'write' ? eff.content : undefined;
	}

	/** Current base truth — bypasses staged layers, overlays, and caches. */
	peekBase(path: string): Promise<unknown> {
		return this.base.peekBase(this.norm(path));
	}

	/** Dirty state is the base's (editor buffers). */
	isDirty(path: string): boolean {
		return this.base.isDirty(this.norm(path));
	}

	/** Dirty paths are the base's (editor buffers). */
	dirtyPaths(): Set<string> {
		return this.base.dirtyPaths();
	}

	/** Subscribes to the single change stream (layers + base). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Fires the change tick (and drops the per-tick effective() memo). */
	notify(): void {
		this.effectiveCache.clear();
		for (const listener of [...this.listeners]) listener();
	}

	// ── Staging surface — checkpoints, commit, rollback, undo ───────────

	/** The current layers, oldest first (read-only view for UI). */
	getLayers(): readonly Layer[] {
		return this.layerStack;
	}

	// ── WorkspaceFs surface (the shell contract; wire shapes) ────────────

	/** The pending snapshot — one call for badges and gates. */
	async pending(): Promise<PendingState> {
		return {
			hasPending: this.hasPendingChanges(),
			changedPaths: Object.fromEntries(this.changedPaths()),
			dirtyPaths: [...this.dirtyPaths()],
		};
	}

	/** Layer METADATA (contents never cross a realm). */
	async layers(): Promise<LayerMeta[]> {
		return this.layerStack.map((l) => ({
			id: l.id,
			label: l.label,
			...(l.sessionId !== undefined ? { sessionId: l.sessionId } : {}),
			...(l.committed !== undefined ? { committed: l.committed } : {}),
			entryCount: l.entries.size,
		}));
	}

	/** Reads a file as UTF-8 text (JSON content is stringified). */
	async readTextFile(path: string): Promise<string> {
		const v = await this.read(path);
		return typeof v === 'string' ? v : JSON.stringify(v);
	}

	/** Writes UTF-8 text. */
	async writeTextFile(path: string, text: string): Promise<void> {
		await this.write(path, text);
	}

	/** Reads a file as base64, size-gated (null = missing / too large). */
	async readFileBase64(path: string, maxBytes: number): Promise<string | null> {
		const v = await this.read(path).catch(() => null);
		if (v === null || v === undefined) return null;
		const bytes = new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
		if (bytes.length > maxBytes) return null;
		let bin = '';
		for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	/** Writes binary carried as base64 (decoded as UTF-8 text — the store
	 *  is text-shaped; true binary rides the store's handle API). */
	async writeFileBase64(path: string, dataB64: string): Promise<void> {
		const bin = atob(dataB64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		await this.write(path, new TextDecoder().decode(bytes));
	}

	/** Glob search over the staged inventory. */
	async findFiles(include: string, exclude?: string): Promise<string[]> {
		await this.ready;
		const inc = globToRegExp(include);
		const exc = exclude ? globToRegExp(exclude) : null;
		return this.listEntries()
			.filter((e) => e.type === 'file' && inc.test(e.path) && !(exc && exc.test(e.path)))
			.map((e) => e.path);
	}

	/** Single virtual root — paths are already workspace-relative. */
	async workspaceRoots(): Promise<string[]> {
		return [];
	}

	/** Change watch. The staged view's change stream is tick-only, so
	 *  every event is the synthetic '' ("re-evaluate everything"). */
	watch(_globs: string[], onEvent: (path: string) => void): () => void {
		return this.subscribe(() => onEvent(''));
	}

	/**
	 * Freezes the working layer as a checkpoint; subsequent mutations open
	 * a fresh working layer.
	 *
	 * @param label - Display label (e.g. the turn title).
	 * @param sessionId - The agent session that produced it, when any.
	 * @returns The frozen layer's id, or null when nothing was staged.
	 */
	async checkpoint(label: string, sessionId?: string): Promise<string | null> {
		const last = this.openLayer();
		if (!last || last.entries.size === 0) return null;
		last.label = label;
		if (sessionId) last.sessionId = sessionId;
		// step: the next mutation creates a fresh working layer above this one
		this.layerStack.push({ id: crypto.randomUUID(), label: 'Working', entries: new Map() });
		this.shape += 1;
		await this.persistAndNotify();
		return last.id;
	}

	/**
	 * Truncates the stack back to a checkpoint ("roll back to here"):
	 * every layer above it is dropped. Server untouched. It runs in its turn
	 * (see dropInTurn), so a write called before it is dropped with the rest.
	 *
	 * @param layerId - The checkpoint to become the top of the stack.
	 */
	rollback(layerId: string): Promise<void> {
		const idx = this.layerStack.findIndex((l) => l.id === layerId);
		if (idx < 0) return Promise.reject(new Error(`No such checkpoint: ${layerId}`));
		// step: a queued write lands in the working layer, which is dropped unless the checkpoint is the
		// top. A commit or Discard all before it takes the checkpoint along, unless all of it was staged
		// after a waiting commit was called (see holdBack), and a running commit sweeps it, so then this
		// rollback expects to drop nothing; what it does drop is counted when it does
		const checkpoint = this.layerStack[idx];
		const taken = this.carriedBefore(Infinity);
		const goes = this.frozen?.has(checkpoint) === true || (taken !== null && (checkpoint.entries.size === 0 || [...checkpoint.entries.values()].some((entry) => (entry.seq ?? 0) <= taken)));
		const foreseen = goes ? new Map<string, boolean>() : this.staged(this.layerStack.slice(idx + 1), idx < this.layerStack.length - 1);
		return this.dropInTurn(
			[ROOT],
			foreseen,
			() => {
				const at = this.layerStack.findIndex((l) => l.id === layerId);
				if (at < 0) throw new Error(`No such checkpoint: ${layerId}`);
				const dropped = this.layerStack.slice(at + 1);
				this.layerStack = this.layerStack.slice(0, at + 1);
				this.evictDroppedFromBaseCache(dropped);
				return {
					dropped: this.entriesOf(dropped),
					settle: async () => {
						await this.persistAndNotify();
						this.announceDropped(dropped);
						await this.gcBestEffort();
					},
				};
			},
			'roll back'
		);
	}

	/**
	 * Drops ONE path's pending changes from every pending layer — the
	 * per-file "git checkout -- <path>": the next read sees the base again.
	 * A rename's two paths are independent entries (write + tombstone), so
	 * discarding one side leaves the other staged — per-path semantics,
	 * exactly like git's. Server untouched. It runs in its turn (see
	 * dropInTurn), so a write of the path called before it is dropped too.
	 *
	 * @param path - The path to revert.
	 */
	discardPath(path: string): Promise<void> {
		const p = this.norm(path);
		const layers = this.pendingLayers();
		const foreseen = new Map([...this.staged(layers, true)].filter(([q]) => q === p));
		// step: nothing staged, queued or being committed: nothing to drop, and no turn to wait for
		if (foreseen.size === 0 && !layers.some((layer) => layer.entries.has(p))) return Promise.resolve();
		return this.dropInTurn(
			[p],
			foreseen,
			() => {
				const dropped = new Map<string, boolean>();
				for (const layer of this.pendingLayers()) {
					const entry = layer.entries.get(p);
					if (entry && layer.entries.delete(p)) dropped.set(p, dropped.get(p) === true || entry.kind === 'tombstone');
				}
				return {
					dropped,
					settle: async () => {
						if (dropped.size === 0) return;
						// step: the path shows the server's copy again, read afresh (see evictDroppedFromBaseCache)
						this.base.invalidate(p);
						await this.persistAndNotify();
						// step: the path's effective content reverted to the base — announce,
						// so per-path consumers (editor models) re-read instead of going stale
						this.onMutate?.(p);
						await this.gcBestEffort();
					},
				};
			},
			`discard the changes in ${p}`
		);
	}

	/**
	 * Drops pending changes. Server untouched. It runs in its turn (see
	 * dropInTurn): after a commit called before it, and after every write
	 * called before it, which it drops too. Until it starts, an operation
	 * called after it expects to drop none of that (see staged()).
	 *
	 * @param path - One path only (see discardPath); omitted = everything pending.
	 */
	discard(path?: string): Promise<void> {
		if (path !== undefined) return this.discardPath(path);
		const foreseen = this.staged(this.pendingLayers(), true);
		const sweep: Sweep = { upTo: this.mutations };
		this.waiting(sweep, true);
		const run = this.dropInTurn(
			[ROOT],
			foreseen,
			() => {
				this.waiting(sweep, false);
				const dropped = this.pendingLayers();
				this.layerStack = this.layerStack.filter((l) => l.committed);
				this.evictDroppedFromBaseCache(dropped);
				return {
					dropped: this.entriesOf(dropped),
					settle: async () => {
						if (this.layerStack.length === 0 && this.staging) {
							await this.staging.sweep();
							this.notify();
							this.announceDropped(dropped);
							return;
						}
						await this.persistAndNotify();
						this.announceDropped(dropped);
						await this.gcBestEffort();
					},
				};
			},
			'discard the changes'
		);
		// step: a discard that never started (its wait ran out) takes nothing
		void run.then(
			() => this.waiting(sweep, false),
			() => this.waiting(sweep, false)
		);
		return run;
	}

	/**
	 * Announces every path a dropped layer set touched — discard/rollback
	 * change effective content WITHOUT a base write, so no backend
	 * announcement exists; without this, per-path consumers (dev-session
	 * Monaco models) keep the rolled-back content forever.
	 *
	 * @param dropped - The layers removed from the stack.
	 */
	private announceDropped(dropped: readonly Layer[]): void {
		if (!this.onMutate) return;
		const paths = new Set<string>();
		for (const layer of dropped) for (const p of layer.entries.keys()) paths.add(p);
		for (const p of paths) this.onMutate(p);
	}

	/**
	 * Evicts dropped layers' paths from the base content cache, so the next
	 * read of each takes the server's copy as it is now: another tab or a
	 * teammate may have changed it, and a commit that met a conflict for it
	 * is resolved by dropping the change and starting from that copy.
	 *
	 * @param dropped - The layers removed from the stack.
	 */
	private evictDroppedFromBaseCache(dropped: readonly Layer[]): void {
		for (const layer of dropped) {
			for (const p of layer.entries.keys()) this.base.invalidate(p);
		}
	}

	/**
	 * How each staged path differs from the base — badges and review rows.
	 *
	 * @returns Map of canonical path to change kind.
	 */
	changedPaths(): Map<string, ChangeKind> {
		const out = new Map<string, ChangeKind>();
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				const eff = this.effective(p);
				if (eff === null) continue;
				if (eff === 'gone') {
					// visible only when the base actually had the path (content
					// capture for files, the dir flag for directories)
					const first = this.firstEntry(p);
					if (first && first.kind !== 'mkdir' && (first.before !== null || (first.kind === 'tombstone' && first.dir))) out.set(p, 'deleted');
					continue;
				}
				if (eff.kind === 'mkdir') { out.set(p, 'added'); continue; }
				if (eff.kind === 'write') {
					const first = this.firstEntry(p);
					const hadBefore = first && first.kind !== 'mkdir' ? first.before !== null : false;
					// step: net identity across layers (changed in a frozen
					// checkpoint, reverted in the working layer) is git-clean —
					// the effective content IS the original capture
					if (hadBefore && first && first.kind !== 'mkdir' && eff.content === first.before) continue;
					out.set(p, hadBefore ? 'modified' : 'added');
				}
			}
		}
		return out;
	}

	/**
	 * Before/after content for review diffs.
	 *
	 * @param path - Canonical path.
	 * @returns Captured before-content and current effective content.
	 */
	async diff(path: string): Promise<{ before: string | null; after: string | null }> {
		const p = this.norm(path);
		const first = this.firstEntry(p);
		const before = first && first.kind !== 'mkdir'
			? first.before
			: await this.effectiveBefore(p);
		let after: string | null = null;
		try {
			const content = await this.read(p);
			after = typeof content === 'string' ? content : null;
		} catch {
			after = null;
		}
		return { before, after };
	}

	/** The OLDEST pending entry for a path (the original capture), among the pending layers or the ones given. */
	private firstEntry(path: string, layers?: readonly Layer[]): LayerEntry | null {
		for (const layer of layers ?? this.pendingLayers()) {
			const entry = layer.entries.get(path);
			if (entry) return entry;
		}
		return null;
	}

	/** The net effect per path across some layers, a commit's frozen ones (top-wins). */
	private netOps(layers: readonly Layer[]): Map<string, LayerEntry> {
		const net = new Map<string, LayerEntry>();
		for (const layer of layers) {
			for (const p of layer.entries.keys()) {
				if (net.has(p)) continue;
				const eff = this.effectiveUncached(p, layers);
				if (eff === 'gone') {
					const first = this.firstEntry(p, layers);
					// deletes only matter when the base actually has the path —
					// content capture for files, the dir flag for directories
					if (first && first.kind === 'tombstone' && (first.before !== null || first.dir)) {
						net.set(p, { kind: 'tombstone', before: first.before, baseHash: first.baseHash, dir: first.dir, stamp: Date.now() });
					} else if (first && first.kind === 'write' && first.before !== null) {
						net.set(p, { kind: 'tombstone', before: first.before, baseHash: first.baseHash, stamp: Date.now() });
					}
				} else if (eff) {
					// carry the ORIGINAL capture so conflicts anchor to first touch
					const first = this.firstEntry(p, layers);
					if (eff.kind === 'write' && first && first.kind !== 'mkdir') {
						// step: net-identity writes replay NOTHING — the content
						// already equals the original capture (mirrors the
						// changedPaths() ruling, so commit matches the badge list)
						if (first.before !== null && eff.content === first.before) continue;
						net.set(p, { ...eff, before: first.before, baseHash: first.baseHash });
					} else {
						net.set(p, eff);
					}
				}
			}
		}
		return net;
	}

	/**
	 * Verifies every staged path against the live base, then replays the
	 * net operations onto it — the only server write.
	 *
	 * ATOMIC-VERIFY / BEST-EFFORT-REPLAY: the verify phase is all-or-nothing
	 * (any conflict aborts with NOTHING written), but the replay phase is a
	 * sequence of independent backend writes — a mid-replay transport
	 * failure leaves the base partially written while the layers (still
	 * intact; they are only swept after a full replay) hold the complete
	 * intent, so re-running commit() finishes the job. There is no server
	 * transaction to lean on; this is the honest contract.
	 *
	 * The commit runs in its turn: after every mutation and staging
	 * operation called before it, waiting for them up to the time limit. It
	 * then moves what mutations called after it staged into a new working
	 * layer (see holdBack) and freezes the layers below. A write while it runs
	 * lands in that working layer, or opens one, and only the frozen layers
	 * are swept, so that write is never lost. The replayed paths are held
	 * until the commit ends, so a later write of one of them lands after it;
	 * a read does not wait for it. The commit counts no version: the view
	 * serves the same content before, during and after it, so an editor or
	 * the agent that read a file is not made stale by it. Until it starts, a
	 * discard called after it expects to drop none of what it will carry (see
	 * staged()).
	 *
	 * @param options.retain - Keep the layers as inert history (auto mode
	 *   undo); otherwise layers and staging are swept.
	 * @returns Committed count, or the conflicts that blocked it.
	 */
	commit(options: { retain?: boolean } = {}): Promise<CommitResult> {
		const sweep: Sweep = { upTo: this.mutations };
		this.waiting(sweep, true);
		const run = this.inTurn('commit', () => this.commitNow(options, sweep));
		// step: a commit that never started (its wait ran out) carries nothing
		void run.then(
			() => this.waiting(sweep, false),
			() => this.waiting(sweep, false)
		);
		return run;
	}

	/**
	 * commit() in its turn: freeze, then verify, replay and sweep.
	 *
	 * @param options.retain - Keep the layers as inert history.
	 * @param sweep - The commit's entry among the operations waiting to start; it leaves them as it freezes.
	 */
	private async commitNow(options: { retain?: boolean }, sweep: Sweep): Promise<CommitResult> {
		await this.ready;
		this.waiting(sweep, false);
		const frozen = this.holdBack(sweep.upTo);
		const net = this.netOps([...frozen]);
		if (net.size === 0) return { committed: 0, conflicts: [] };
		this.frozen = frozen;
		this.shape += 1;
		try {
			return await this.mutate([...net.keys()], 'commit', () => this.replay(net, frozen, options), { count: false, after: [], holdsReads: false });
		} finally {
			this.frozen = null;
			this.shape += 1;
		}
	}

	/**
	 * Holds back what mutations called after a commit staged, so the commit
	 * carries only what was staged before it was called, and a discard called
	 * after it drops the rest (it counted it, see staged()). Such entries sit
	 * in layers above everything the commit carries (see openLayer), except
	 * where a mutation called before the commit landed late, in a layer that
	 * already held them: there they move to a new layer just above it. The
	 * order of the layers, and every checkpoint the commit does not carry,
	 * stay as they were.
	 *
	 * @param upTo - The number of the last staged mutation called before the commit.
	 * @returns The layers the commit carries: every pending layer that holds nothing staged after it was called.
	 */
	private holdBack(upTo: number): Set<Layer> {
		const carried = new Set<Layer>();
		for (let i = 0; i < this.layerStack.length; i++) {
			const layer = this.layerStack[i];
			if (layer.committed) continue;
			const later = [...layer.entries].filter(([, entry]) => (entry.seq ?? 0) > upTo);
			if (later.length > 0 && later.length === layer.entries.size) continue;
			carried.add(layer);
			if (later.length === 0) continue;
			for (const [p] of later) layer.entries.delete(p);
			this.layerStack.splice(i + 1, 0, { id: crypto.randomUUID(), label: 'Working', entries: new Map(later) });
			i += 1;
		}
		this.shape += 1;
		this.effectiveCache.clear();
		return carried;
	}

	/**
	 * A commit's verify, replay and sweep, over the net operations of the
	 * layers it froze.
	 *
	 * @param net - The net operations.
	 * @param frozen - The layers they come from, the only ones swept.
	 * @param options.retain - Keep the layers as inert history.
	 * @returns Committed count, or the conflicts that blocked it.
	 */
	private async replay(net: Map<string, LayerEntry>, frozen: ReadonlySet<Layer>, options: { retain?: boolean }): Promise<CommitResult> {
		// step: verify — the base must still match every first-touch capture.
		// Tombstones whose outcome the base ALREADY holds are marked converged
		// and excluded from the replay (deleting a gone path would throw).
		const conflicts: StagedConflict[] = [];
		const converged = new Set<string>();
		for (const [p, entry] of net) {
			if (entry.kind === 'mkdir') continue;
			// step: a DIRECTORY tombstone anchors on existence, not content —
			// gone already = converged; still a dir = passes and replays
			if (entry.kind === 'tombstone' && entry.dir) {
				if ((await this.base.stat(p)) === null) converged.add(p);
				continue;
			}
			let current: string | null = null;
			try {
				// step: base truth, never a dirty overlay (see effectiveBefore)
				const content = await this.base.peekBase(p);
				current = typeof content === 'string' ? content : null;
			} catch {
				current = null;
			}
			// step: convergence — a base that already holds this entry's net
			// OUTCOME (same content, or already deleted) is never a conflict;
			// this is what lets a re-run finish a partially replayed commit
			if (entry.kind === 'write' && current === entry.content) continue;
			if (entry.kind === 'tombstone' && current === null) {
				converged.add(p);
				continue;
			}
			if (entry.baseHash === null) {
				if (current !== null) conflicts.push({ path: p, reason: 'resurrected' });
			} else if (current === null) {
				conflicts.push({ path: p, reason: 'missing' });
			} else if ((await sha256Hex(current)) !== entry.baseHash) {
				conflicts.push({ path: p, reason: 'changed' });
			}
		}
		if (conflicts.length > 0) return { committed: 0, conflicts };

		// step: replay — mkdirs shallow-first, writes, deletes deep-first
		const paths = [...net.keys()];
		const depth = (p: string) => p.split('/').length;
		for (const p of paths.filter((x) => net.get(x)!.kind === 'mkdir').sort((a, b) => depth(a) - depth(b))) {
			await this.base.mkdir(p);
		}
		for (const p of paths.filter((x) => net.get(x)!.kind === 'write')) {
			const entry = net.get(p)! as Extract<LayerEntry, { kind: 'write' }>;
			await this.changeBase([p], () => this.base.write(p, entry.content));
		}
		for (const p of paths.filter((x) => net.get(x)!.kind === 'tombstone' && !converged.has(x)).sort((a, b) => depth(b) - depth(a))) {
			await this.changeBase([p], () => this.base.delete(p));
		}

		// step: sweep or retain the frozen layers; a working layer opened meanwhile stays
		if (options.retain) {
			for (const layer of frozen) {
				if (layer.entries.size > 0) layer.committed = true;
			}
			this.layerStack = this.layerStack.filter((l) => l.entries.size > 0);
			this.shape += 1;
			await this.persistAndNotify();
			await this.gcBestEffort();
		} else {
			this.layerStack = this.layerStack.filter((l) => !frozen.has(l) && !l.committed);
			this.shape += 1;
			this.effectiveCache.clear();
			if (this.layerStack.length > 0) {
				await this.persistAndNotify();
				await this.gcBestEffort();
			} else {
				if (this.staging) await this.staging.sweep();
				this.notify();
			}
		}
		return { committed: net.size, conflicts: [] };
	}

	/**
	 * Inverse-replays a retained (committed) checkpoint AND everything
	 * committed after it — auto mode's "Undo this turn". Hash-guarded: if
	 * any affected file changed on the base since its commit, nothing is
	 * undone and the conflicts are returned.
	 *
	 * It runs in its turn, like commit(). The paths it restores are counted
	 * and held from the moment it knows them, before the guard reads the
	 * base: a write of one of them called after that lands after the undo.
	 *
	 * @param layerId - The oldest checkpoint to undo.
	 * @returns Undone path count, or blocking conflicts.
	 */
	undoTurn(layerId: string): Promise<CommitResult> {
		return this.inTurn('undo the turn', () => this.undoNow(layerId));
	}

	/** undoTurn() in its turn. */
	private async undoNow(layerId: string): Promise<CommitResult> {
		await this.ready;
		const idx = this.layerStack.findIndex((l) => l.id === layerId);
		if (idx < 0 || !this.layerStack[idx].committed) throw new Error(`No such committed checkpoint: ${layerId}`);
		const undoing = this.layerStack.slice(idx).filter((l) => l.committed);

		// step: inverse per path = the OLDEST capture among undone layers;
		// expected current = the NEWEST write among them
		const inverse = new Map<string, { before: string | null; expected: string | null }>();
		for (const layer of undoing) {
			for (const [p, entry] of layer.entries) {
				if (entry.kind === 'mkdir') continue;
				const prior = inverse.get(p);
				const expected = entry.kind === 'write' ? entry.content : null;
				// step: oldest capture is the restore target; newest op is the guard
				if (!prior) inverse.set(p, { before: entry.before, expected });
				else prior.expected = expected;
			}
		}

		// step: the restored paths are counted and held from here: the undo
		// changes what the view serves, and a later write lands after it
		const removed = [...inverse].filter(([, { before }]) => before === null).map(([p]) => p);
		return this.mutate([...inverse.keys()], 'undo', () => this.restore(inverse, undoing), { removed, after: [] });
	}

	/**
	 * An undo's guard, inverse replay and drop of the undone history.
	 *
	 * @param inverse - Per path: the content to restore (null deletes it) and what the base must still hold.
	 * @param undoing - The committed layers being undone.
	 * @returns Undone path count, or blocking conflicts.
	 */
	private async restore(inverse: Map<string, { before: string | null; expected: string | null }>, undoing: Layer[]): Promise<CommitResult> {
		// step: guard — the base must still hold what these turns wrote
		const conflicts: StagedConflict[] = [];
		for (const [p, { expected }] of inverse) {
			let current: string | null = null;
			try {
				// step: base truth, never a dirty overlay (see effectiveBefore)
				const content = await this.base.peekBase(p);
				current = typeof content === 'string' ? content : null;
			} catch {
				current = null;
			}
			if (current !== expected) conflicts.push({ path: p, reason: 'changed' });
		}
		if (conflicts.length > 0) return { committed: 0, conflicts };

		// step: inverse replay — restore before-content, delete creations
		for (const [p, { before }] of inverse) {
			if (before === null) await this.changeBase([p], () => this.base.delete(p));
			else await this.changeBase([p], () => this.base.write(p, before));
		}

		// step: the undone history is spent
		this.layerStack = this.layerStack.filter((l) => !undoing.includes(l));
		this.shape += 1;
		if (this.layerStack.length === 0 && this.staging) {
			await this.staging.sweep();
			this.notify();
		} else {
			await this.persistAndNotify();
			await this.gcBestEffort();
		}
		return { committed: inverse.size, conflicts: [] };
	}
}

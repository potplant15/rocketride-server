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
// CANVAS DOCUMENT — the save state every canvas of one pipeline shares
// =============================================================================

/**
 * A split shows one pipeline document in two canvases, and Documents keeps one
 * copy of its content and dirty flag for both. The version the content was
 * loaded at, and whether it is being saved or reloaded, belong to that
 * document too, not to one canvas: otherwise a save from one split would leave
 * the other split's version behind, and its next save would be refused as if
 * someone else had changed the file.
 *
 * The document lives while Documents holds the pipeline. A canvas that
 * unmounts while Documents keeps it (a tab moved to another group, a split,
 * a layout change) mounts again at once and finds the same document, with
 * its saves still on their way. Closing the last view drops the pipeline
 * from Documents, dirty or not (the shell asks first, through its
 * dirty-close dialog), and the document goes with it. When the app tears
 * Documents down (a team switch, signing out), no pipeline was closed: the
 * document goes with its last canvas, and its saves still land in the team
 * they were called in. While it lives it guards the file for the agent,
 * which asks before it changes a dirty pipeline, and the user's "Save mine
 * first" or "Discard mine" is carried out here.
 *
 * A clean canvas follows the stored file when something else changes it. A
 * reload that fails (the pipeline is gone, not valid JSON, or the read failed)
 * keeps the old version, so the next save is refused, and is tried again on
 * the next change.
 *
 * Each save waits for the one before it. A reload (the agent's "Discard
 * mine", the stale dialog's Reload, a clean canvas following a change),
 * Overwrite and closing the pipeline's last tab all replace or drop the
 * pipeline a waiting save was called with. Each of them moves the
 * document's generation before it awaits anything, and a save called in an
 * earlier generation then writes nothing and rejects with SaveDroppedError:
 * what waits on it (Save & Run, a publish, the agent's edit after "Save mine
 * first", the close dialog's Save) stops, and no canvas shows it as a
 * failure. A reload moves the generation again when it puts the stored
 * pipeline on screen, since a save called during its read holds the
 * pipeline it replaced, so a save waits for a reload on its way before it
 * writes. A write already on its way when the generation moves still lands,
 * and its save resolves; one that fails rejects with SaveDroppedError too.
 * The canvas takes the write's version unless a reload put another pipeline
 * on screen meanwhile (typing during a reload that kept it builds on the
 * write), and follows the stored file once its saves are done.
 */

import { useEffect, useState } from 'react';
import { SaveDroppedError } from 'shared/modules/agent/host';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { registerEditor } from '../../agent/editorControls';
import { loadedVersion, reloadPipeline, savePipeline, type ProjectVfs } from '../workspace/projectVfs';

/** The version of content this page did not read or save (Documents restored it at boot): no version matches it, so its first save asks, and a clean canvas reloads it. */
export const RESTORED = -1;

/** What a pipeline document needs of Documents. */
export interface CanvasDocs {
	getState(): { documents: Record<string, { dirty: boolean; content: unknown; version: number } | undefined> };
	saveDocument(uri: string): Promise<void>;
	revertDocument(uri: string): Promise<void>;
	/** Hears each change: the document goes when Documents drops the pipeline. */
	subscribe(listener: () => void): () => void;
	/** True once the app tore Documents down (a team switch, signing out), which closes no pipeline. */
	readonly destroyed?: boolean;
}

/** The open documents, by workspace view, then by view path. */
const documents = new WeakMap<IWorkspaceFileSystem, Map<string, CanvasDocument>>();

/**
 * The open documents of a view.
 *
 * @param view - The workspace view.
 */
function shelf(view: IWorkspaceFileSystem): Map<string, CanvasDocument> {
	let shelved = documents.get(view);
	if (!shelved) {
		shelved = new Map();
		documents.set(view, shelved);
	}
	return shelved;
}

/** The save state of one open pipeline document. */
export class CanvasDocument {
	/** The view version the document's content was loaded at; a save names it. RESTORED for content this page never read or saved. */
	version: number;
	/** True while a save runs or waits its turn, so its own write does not read as an outside change. */
	saving = false;
	/** True while the stored pipeline is read again, past every editor's unsaved buffer. */
	reloading = false;
	/** The reload in flight, which a second caller waits for instead of starting another. */
	reload?: Promise<boolean>;
	/** How many mounted canvases show it. */
	canvases = 0;
	/** The project VFS the newest canvas saves through. */
	projectVfs: ProjectVfs | null = null;

	/** The mounted canvases' saves, newest last; each shows its own failure. */
	private readonly canvasSaves: Array<() => Promise<void>> = [];
	/** The newest save called, what it writes, and its generation; a save called while it runs follows it. */
	private lastSave: { key: string; generation: number; done: Promise<void> } | null = null;
	/** Moves when the pipeline a save was called with is replaced or dropped (a reload, Overwrite, closing its last tab); a save called before the move writes nothing. */
	private generation = 0;
	/** How many reloads replaced the pipeline on screen; a write's version is the pipeline's only when none did since its save was called. */
	private reloads = 0;
	/** Removes the document's registration with the agent's editors and the view's overlay. */
	private unregister: (() => void) | null = null;
	/** Stops following the view. */
	private unwatchView: (() => void) | null = null;
	/** Stops hearing Documents. */
	private unwatchDocs: (() => void) | null = null;
	/** True once the document went (see settle); a canvas that mounts later gets a new one. */
	private released = false;

	/**
	 * @param view - The workspace view.
	 * @param docs - The Documents instance that holds the pipeline.
	 * @param path - The pipeline's view path.
	 * @param uri - The pipeline's document URI (also its project-store path).
	 */
	constructor(
		readonly view: IWorkspaceFileSystem,
		readonly docs: CanvasDocs,
		readonly path: string,
		readonly uri: string
	) {
		// step: the version the content was read at, not the view's now, which may have moved on while the read was on its way.
		// Content this page never read (typing, or what Documents restored at boot) has none, so its first save asks Reload or Overwrite
		this.version = loadedVersion(docs.getState().documents[uri]?.content) ?? RESTORED;
	}

	/** True while Documents holds the pipeline with changes not saved. */
	documentDirty(): boolean {
		return this.docs.getState().documents[this.uri]?.dirty === true;
	}

	/**
	 * A canvas mounts on the document: the document joins the agent's editors,
	 * and follows the stored file while any canvas shows it.
	 *
	 * @param save - The canvas's save, which shows its own failure.
	 * @returns Unmounts the canvas. The document stays while Documents holds the pipeline (see settle).
	 */
	open(save: () => Promise<void>): () => void {
		const shelved = shelf(this.view);
		if (!shelved.has(this.path)) shelved.set(this.path, this);
		this.unregister ??= registerEditor(this.view, this.path, {
			uri: this.uri,
			getContent: () => JSON.stringify(this.docs.getState().documents[this.uri]?.content, null, 2),
			isDirty: () => this.documentDirty(),
			// step: the newest canvas saves, and shows a failure; while a moved canvas mounts again the document saves itself
			save: () => this.canvasSaves[this.canvasSaves.length - 1]?.() ?? this.save(this.docs.getState().documents[this.uri]?.content),
			discard: async () => {
				if (!(await this.reloadStored(false))) throw new Error(`${this.path} could not be loaded again: the stored pipeline is gone, is not valid JSON, or could not be read`);
			},
		});
		this.unwatchDocs ??= this.docs.subscribe(() => this.settle());
		this.canvasSaves.push(save);
		this.canvases += 1;
		this.unwatchView ??= this.view.subscribe(() => this.follow());
		this.follow();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			const at = this.canvasSaves.lastIndexOf(save);
			if (at >= 0) this.canvasSaves.splice(at, 1);
			this.canvases -= 1;
			if (this.canvases > 0) return;
			this.unwatchView?.();
			this.unwatchView = null;
			// step: a tab moved to another group, a split or a layout change mounts the canvas again at once, and
			// Documents keeps the pipeline meanwhile, so the document and its saves stay
			this.settle();
		};
	}

	/**
	 * Saves a pipeline at the version the document was loaded at: one write,
	 * then Documents marks the tab clean. A save called while another runs
	 * (a second Ctrl+S, the agent's "Save mine first", the close dialog's
	 * Save) is that save when it writes the same pipeline to the same file
	 * in the same generation. Another pipeline saves once it is done, at the
	 * version it wrote: its write already moved the file's version, so a
	 * save at the loaded version would be refused as a change from outside
	 * this editor.
	 *
	 * Overwrite saves the pipeline as it is at the click, so it moves the
	 * generation: the saves waiting their turn write nothing. A save whose
	 * generation moved, or whose pipeline's last tab closed, before its write
	 * started writes nothing and rejects with SaveDroppedError. So does one
	 * whose write was on its way and failed; one whose write lands resolves.
	 *
	 * @param content - The pipeline.
	 * @param opts.overwrite - Save over a newer pipeline on purpose (the stale dialog's Overwrite).
	 * @param opts.filename - The project-store path to write (the document's URI by default).
	 * @returns Rejects when the save did not land: a pipeline that moved on refuses it with StaleWriteError, and one the user dropped meanwhile with SaveDroppedError.
	 */
	async save(content: unknown, opts: { overwrite?: boolean; filename?: string } = {}): Promise<void> {
		if (!this.projectVfs) throw new Error(`${this.path} cannot be saved: no canvas has opened it`);
		const key = JSON.stringify([opts.filename ?? this.uri, opts.overwrite === true, content]);
		const ahead = this.lastSave;
		if (ahead?.key === key && ahead.generation === this.generation) return ahead.done;
		if (opts.overwrite) this.generation += 1;
		const [generation, reloads] = [this.generation, this.reloads];
		this.saving = true;
		const mine: { key: string; generation: number; done: Promise<void> } = { key, generation, done: Promise.resolve() };
		this.lastSave = mine;
		mine.done = (async () => {
			try {
				// step: the save before it lands first, or fails; either way this one names the version it left
				if (ahead) await ahead.done.catch(() => undefined);
				// step: a reload on its way may still put the stored pipeline on screen, which drops this one
				while (this.reload) await this.reload.catch(() => false);
				// step: a reload, Overwrite or closing the pipeline's last tab since the call dropped this pipeline
				if (this.dropped(generation)) throw new SaveDroppedError(this.path);
				await this.write(content, opts, generation, reloads);
			} catch (err) {
				// step: a write on its way that failed after the user dropped its pipeline did not land either, and is no failure to show
				if (!(err instanceof SaveDroppedError) && this.dropped(generation)) throw new SaveDroppedError(this.path);
				throw err;
			} finally {
				// step: the document stays saving until the newest save is done, then catches up on a change the saves held off
				if (this.lastSave === mine) {
					this.lastSave = null;
					this.saving = false;
					this.follow();
				}
			}
		})();
		return mine.done;
	}

	/**
	 * One save in its turn (see save).
	 *
	 * @param content - The pipeline.
	 * @param opts - See save.
	 * @param generation - The generation the save was called in.
	 * @param reloads - How many reloads had replaced the pipeline when the save was called.
	 */
	private async write(content: unknown, opts: { overwrite?: boolean; filename?: string }, generation: number, reloads: number): Promise<void> {
		const projectVfs = this.projectVfs as ProjectVfs;
		if (opts.overwrite) {
			// step: adopt the version at the click, and the server's copy as the freshness baseline. The
			// view reads the copy again, so a read that a change overtook is not adopted, and a change
			// that lands during the read moves the file past the adopted version, so the save asks again
			const version = this.view.version(this.path);
			this.view.invalidate(this.path);
			try {
				await this.view.readVersioned(this.path, { stored: true });
			} catch {
				/* not on the server yet: nothing to adopt */
			}
			// step: a reload or closing the pipeline's last tab during the read dropped this pipeline
			if (this.dropped(generation)) throw new SaveDroppedError(this.path);
			this.version = version;
		}
		const written = await savePipeline(projectVfs, this.docs, opts.filename ?? this.uri, this.uri, content, this.version);
		// step: typing since the call builds on this write; a pipeline a reload put on screen meanwhile has its own version
		if (this.reloads === reloads) this.version = written;
	}

	/**
	 * Drops the unsaved changes and reloads the stored pipeline (the agent's
	 * "Discard mine", the stale dialog's Reload, and a clean canvas following
	 * an outside change). The loaded version moves only when the content did:
	 * a pipeline that could not be loaded leaves both as they were, so the
	 * next save is refused instead of overwriting that change unseen. The
	 * saves waiting their turn are dropped with the pipeline on screen.
	 *
	 * @param fresh - Read the server's copy as it is now, not the view's cached copy, which is older when another tab or a teammate changed the pipeline (the stale dialog's Reload, which follows a refused save, so the canvas's version is behind the file's and a save of typing that lands during the read is refused too). False for a clean canvas following a change in this page, and for "Discard mine": the cache holds what the page knows, and a write over an older copy is refused.
	 * @returns True when the stored pipeline was loaded.
	 */
	reloadStored(fresh = true): Promise<boolean> {
		// step: the saves waiting their turn hold the pipeline this reload replaces, so they are dropped before anything awaits
		this.generation += 1;
		// step: a reload already on its way (from another split, or a clean canvas following a change) is the one to wait
		// for. It may have read the cached copy, so a fresh reload then reads again
		if (this.reload) return fresh ? this.reload.then(() => this.reloadStored()) : this.reload;
		if (fresh) this.view.invalidate(this.path);
		this.reloading = true;
		const reload = (async (): Promise<boolean> => {
			try {
				const version = await reloadPipeline(this.docs, this.uri);
				if (version === null) return false;
				// step: a save called during the read holds the pipeline this replaced
				this.version = version;
				this.reloads += 1;
				this.generation += 1;
				return true;
			} finally {
				this.reloading = false;
				this.reload = undefined;
			}
		})();
		this.reload = reload;
		return reload;
	}

	/** A clean document a canvas shows reloads when the stored pipeline moved on; one that failed to load tries again on each change. */
	private follow(): void {
		if (!this.unwatchView || this.documentDirty() || this.saving || this.reloading) return;
		if (this.view.version(this.path) !== this.version) void this.reloadStored(false);
	}

	/**
	 * True when a save called in a generation can no longer write its
	 * pipeline: the generation moved (a reload or Overwrite replaced it), or
	 * the pipeline's last tab closed.
	 *
	 * @param generation - The generation the save was called in.
	 */
	private dropped(generation: number): boolean {
		return generation !== this.generation || this.closed();
	}

	/** True when Documents, still in use, no longer holds the pipeline: the user closed its last tab. */
	private closed(): boolean {
		return this.docs.destroyed !== true && this.docs.getState().documents[this.uri] === undefined;
	}

	/**
	 * The document goes when Documents drops the pipeline (its last tab
	 * closed, Don't Save or clean), and the saves waiting their turn go with
	 * it. When the app tore Documents down instead (a team switch), it goes
	 * with its last canvas, and its saves still land. While Documents holds
	 * the pipeline it stays, with or without a canvas.
	 */
	private settle(): void {
		if (this.released) return;
		if (this.closed()) this.release(true);
		else if (this.docs.destroyed === true && this.canvases === 0) this.release(false);
	}

	/**
	 * Drops the document from the view's shelf, the agent's editors and Documents' listeners.
	 *
	 * @param drop - True to drop the saves waiting their turn with the pipeline.
	 */
	private release(drop: boolean): void {
		this.released = true;
		if (drop) this.generation += 1;
		const shelved = shelf(this.view);
		if (shelved.get(this.path) === this) shelved.delete(this.path);
		this.unregister?.();
		this.unregister = null;
		this.unwatchDocs?.();
		this.unwatchDocs = null;
		this.unwatchView?.();
		this.unwatchView = null;
		this.view.notify();
	}
}

/**
 * The document of a pipeline: the one its canvases share, or a new one, which
 * every canvas of the pipeline then finds.
 *
 * @param view - The workspace view.
 * @param docs - The Documents instance that holds the pipeline.
 * @param path - The pipeline's view path.
 * @param uri - The pipeline's document URI.
 * @param shared - False for a pipeline with no stored file to check (a new or read-only one): it gets a document of its own.
 * @returns The document; a canvas joins it with open().
 */
export function canvasDocument(view: IWorkspaceFileSystem, docs: CanvasDocs, path: string, uri: string, shared = true): CanvasDocument {
	if (!shared) return new CanvasDocument(view, docs, path, uri);
	const shelved = shelf(view);
	let doc = shelved.get(path);
	if (!doc) {
		doc = new CanvasDocument(view, docs, path, uri);
		shelved.set(path, doc);
	}
	return doc;
}

/**
 * Joins the document of a pipeline while the calling canvas is mounted.
 *
 * @param view - The workspace view.
 * @param docs - The Documents instance that holds the pipeline.
 * @param path - The pipeline's view path.
 * @param uri - The pipeline's document URI.
 * @param save - The canvas's save, which shows its own failure.
 * @param tracked - False for a new or read-only pipeline: no stored file to check, nothing the agent could change.
 * @returns The document.
 */
export function useCanvasDocument(view: IWorkspaceFileSystem, docs: CanvasDocs, path: string, uri: string, save: () => Promise<void>, tracked: boolean): CanvasDocument {
	// step: found at render, so the canvas's callbacks see it from the first render
	const [doc, setDoc] = useState(() => canvasDocument(view, docs, path, uri, tracked));
	useEffect(() => {
		const current = canvasDocument(view, docs, path, uri, tracked);
		setDoc(current);
		return tracked ? current.open(save) : undefined;
	}, [view, docs, path, uri, save, tracked]);
	return doc;
}

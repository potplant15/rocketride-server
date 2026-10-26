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
// FILE DOCUMENT — the text, version and save state every tab of one file shares
// =============================================================================

/**
 * A workspace text file shows in Monaco tabs (FileProvider), and every tab of
 * one path binds to the same Monaco model, which Monaco keeps for the whole
 * page. So the text belongs to the file, not to a tab, and so do the view
 * version it was loaded at, whether it is unsaved, and whether a save or a
 * reload is under way:
 *
 *   - Two splits of one file share them, so a save from one split leaves the
 *     other clean at the new version.
 *   - Unsaved text outlives its last tab, and so does the version it was
 *     loaded at. When the tab opens again, its save names that version: if
 *     the file moved on meanwhile, the save is refused and the banner offers
 *     Reload or Overwrite, instead of writing the old text over the change.
 *   - While unsaved text survives with no tab open, the file stays dirty for
 *     the agent, which asks before it changes the file, and the user's
 *     "Save mine first" or "Discard mine" is carried out here. The Explorer
 *     marks the file as unsaved.
 *
 * A document lives while a tab shows it, while its text is unsaved, or while
 * a load of it is on its way: a load that lands sets the shared Monaco model,
 * so it must land in the document the next tab shows. A clean document with
 * no tab and no load is dropped, and the next tab loads the stored file
 * afresh.
 *
 * Each save waits for the one before it. Discard mine, the banner's Reload
 * and Overwrite each move the document's generation before they await
 * anything, and a save called in an earlier generation then writes nothing
 * and rejects with SaveDroppedError: what waits on it (the agent's edit
 * after "Save mine first") stops, and the tab shows no failure. A write
 * already on its way when the generation moves still lands, and its save
 * resolves; one that fails rejects with SaveDroppedError too. Discard mine
 * shows the stored text it had at once, so text on screen that differs from
 * what the write wrote does not take its version: the document loads the
 * stored file once its saves are done, or, when the user typed meanwhile,
 * turns stale. Closing the last tab, or moving a tab to another group (it
 * unmounts and mounts again), drops nothing: unsaved text keeps its
 * document, and a save waiting its turn still lands. A clean document goes with its last tab,
 * and a save of it waiting its turn finds nothing unsaved, so it writes
 * nothing and resolves.
 */

import { SaveDroppedError } from 'shared/modules/agent/host';
import { StaleWriteError } from 'shared/modules/vfs/stagedFileSystem';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { registerEditor } from '../../agent/editorControls';

/** The open documents, by workspace view, then by path. */
const documents = new WeakMap<IWorkspaceFileSystem, Map<string, FileDocument>>();

/**
 * The open documents of a view.
 *
 * @param view - The workspace view.
 */
function shelf(view: IWorkspaceFileSystem): Map<string, FileDocument> {
	let shelved = documents.get(view);
	if (!shelved) {
		shelved = new Map();
		documents.set(view, shelved);
	}
	return shelved;
}

/** One workspace text file as its tabs show it. */
export class FileDocument {
	/** The text the tabs show: the stored file while clean, the user's typing while dirty; null until loaded. */
	text: string | null = null;
	/** The view version the text was loaded or last saved at; a save names it. */
	version = 0;
	/** True while the text holds typing that is not saved. */
	dirty = false;
	/** True when the stored file moved on while the text was dirty, or a save was refused for it. */
	stale = false;
	/** Why the stored file could not be read, while the text is clean. */
	error: string | null = null;
	/** Why the last save failed, when the failure was not a newer file. */
	saveError: string | null = null;
	/** True while a save runs or waits its turn; its own write is not an outside change. */
	saving = false;
	/** True while the document sets the editors' text itself, which is not typing. */
	applying = false;
	/** How many tabs show it. */
	tabs = 0;
	/** How many loads were started; only the newest one's result applies, success or failure. */
	private loads = 0;
	/** How many loads are on their way; the document stays while any is. */
	private loading = 0;
	/** The stored text the text was loaded from or saved as; unsaved typing is based on it. Null until loaded. */
	private base: string | null = null;
	/** The newest save called, the text it was called with, and its generation; a save called while it runs follows it. */
	private lastSave: { text: string; overwrite: boolean; generation: number; done: Promise<void> } | null = null;
	/** Moves when the text is dropped or saved over on purpose (Discard mine, Reload, Overwrite); a save called before the move writes nothing. */
	private generation = 0;
	/**
	 * Puts text into the Monaco model of this path, when there is one. Each
	 * tab's editor sets it as it mounts, and it goes with the last tab; the
	 * model outlives every tab, and the text stays here meanwhile.
	 */
	sync?: (text: string) => void;

	/** Who hears each change (the tabs, which render it). */
	private readonly listeners = new Set<() => void>();
	/** Removes the file's registration with the agent's editors and the view's overlay. */
	private unregister: (() => void) | null = null;
	/** Stops following the view. */
	private unwatch: (() => void) | null = null;

	/**
	 * @param view - The workspace view the file is read from and saved through.
	 * @param path - The file's workspace path.
	 */
	constructor(
		readonly view: IWorkspaceFileSystem,
		readonly path: string
	) {}

	/**
	 * A tab opens on the document: the document joins the view's open
	 * documents and the agent's editors, and follows the stored file while
	 * any tab shows it.
	 *
	 * @returns Closes the tab; the document goes with its last tab unless its text is unsaved.
	 */
	open(): () => void {
		const shelved = shelf(this.view);
		if (!shelved.has(this.path)) shelved.set(this.path, this);
		this.unregister ??= registerEditor(this.view, this.path, {
			uri: `file:${this.path}`,
			getContent: () => this.text ?? undefined,
			isDirty: () => this.dirty,
			save: () => this.save(),
			discard: () => this.discard(),
		});
		this.tabs += 1;
		this.unwatch ??= this.view.subscribe(() => void this.load());
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.tabs -= 1;
			if (this.tabs > 0) return;
			this.unwatch?.();
			this.unwatch = null;
			// step: the model is keyed by the path alone, so after a team switch a tab of another team's
			// document may show it. The next tab's editor binds this document again (FileProvider's beforeMount)
			this.sync = undefined;
			this.releaseIfIdle();
		};
	}

	/**
	 * Hears each change to the document.
	 *
	 * @param listener - Called with no arguments.
	 * @returns Stops hearing.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Reads the stored file into a clean document, past every editor's
	 * unsaved buffer: a canvas's unsaved pipeline on the same file stays the
	 * canvas's, and is not loaded as this document's clean text. Unsaved text
	 * is never replaced; when the stored file moved on under it, the document
	 * turns stale instead. A read never takes the document back to an older
	 * version, and a load that a newer one overtook changes nothing, whether
	 * it worked or failed.
	 */
	async load(): Promise<void> {
		const busy = (): boolean => {
			if (this.saving) return true;
			if (!this.dirty) return false;
			if (!this.stale && this.view.version(this.path) !== this.version) {
				this.stale = true;
				this.changed();
			}
			return true;
		};
		if (busy()) return;
		const mine = ++this.loads;
		this.loading += 1;
		try {
			const { content, version } = await this.view.readVersioned(this.path, { stored: true });
			const stored = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
			if (mine !== this.loads || busy() || (this.text !== null && version < this.version)) return;
			this.version = version;
			this.base = stored;
			this.apply(stored);
			this.stale = false;
			this.error = null;
		} catch (err) {
			if (mine !== this.loads || this.dirty) return;
			this.text = null;
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading -= 1;
			if (this.tabs === 0) this.releaseIfIdle();
		}
		this.changed();
	}

	/**
	 * The user typed: the text is now unsaved. Text equal to what the
	 * document holds, or the editors echoing the document's own change, is not
	 * typing.
	 *
	 * @param text - The editor's whole text.
	 */
	type(text: string): void {
		if (this.applying || text === this.text) return;
		this.text = text;
		this.markDirty(true);
		this.changed();
	}

	/**
	 * Saves the text at the version it was loaded at. A file that moved on
	 * refuses the save and turns the document stale (the banner's Reload and
	 * Overwrite). Typing during the save keeps the document dirty.
	 *
	 * A save called while another runs (Ctrl+S again, or the agent's "Save
	 * mine first") is that save when the text is the same and the generation
	 * has not moved, so it settles when that save does. Newer typing saves
	 * once that save is done, at the version it wrote.
	 *
	 * Overwrite saves the text as it is at the click, so it moves the
	 * generation: the saves waiting their turn write nothing. A save whose
	 * generation moved before its write started writes nothing and rejects
	 * with SaveDroppedError. So does one whose write was on its way and
	 * failed; one whose write lands resolves.
	 *
	 * @param overwrite - Save over a newer file on purpose (the banner's Overwrite).
	 * @returns Rejects when the save did not land: with StaleWriteError for a file that moved on, and SaveDroppedError for text the user dropped meanwhile.
	 */
	save(overwrite = false): Promise<void> {
		const text = this.text ?? '';
		const ahead = this.lastSave;
		if (ahead && ahead.generation === this.generation && ahead.text === text && ahead.overwrite === overwrite) return ahead.done;
		if (!ahead && !this.dirty) return Promise.resolve();
		if (overwrite) this.generation += 1;
		const generation = this.generation;
		this.saving = true;
		this.changed();
		const mine: { text: string; overwrite: boolean; generation: number; done: Promise<void> } = { text, overwrite, generation, done: Promise.resolve() };
		this.lastSave = mine;
		mine.done = (async () => {
			let failed = false;
			try {
				// step: the save before it lands first, or fails; either way this one names the version it left
				if (ahead) await ahead.done.catch(() => undefined);
				// step: Discard mine, Reload or Overwrite since the call dropped this text
				if (generation !== this.generation) throw new SaveDroppedError(this.path);
				await this.write(overwrite, generation);
			} catch (err) {
				// step: a write on its way that failed after the user dropped its text did not land either, and is no failure to show
				if (!(err instanceof SaveDroppedError) && generation !== this.generation) throw new SaveDroppedError(this.path);
				failed = !(err instanceof SaveDroppedError);
				throw err;
			} finally {
				// step: the document stays saving until the newest save is done
				if (this.lastSave === mine) {
					this.lastSave = null;
					this.saving = false;
				}
				this.changed();
				// step: after a save that landed or was dropped, catch up on anything that changed while the saves ran
				if (!failed && !this.saving && this.tabs > 0) void this.load();
			}
		})();
		return mine.done;
	}

	/**
	 * One save in its turn (see save): the text as it is now, unless nothing
	 * is unsaved by then.
	 *
	 * @param overwrite - See save.
	 * @param generation - The generation the save was called in.
	 */
	private async write(overwrite: boolean, generation: number): Promise<void> {
		if (!this.dirty) return;
		const text = this.text ?? '';
		try {
			if (overwrite) {
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
				// step: Discard mine or Reload during the read dropped this text
				if (generation !== this.generation) throw new SaveDroppedError(this.path);
				this.version = version;
			}
			const writing = this.view.write(this.path, text, 'editor', this.version);
			const mine = this.view.version(this.path);
			await writing;
			// step: text dropped while the write was on its way shows the stored text it had, which is not at the version written
			if (generation !== this.generation && this.text !== text) return;
			this.version = mine;
			this.base = text;
			this.stale = false;
			this.saveError = null;
			if (this.text === text) this.markDirty(false);
		} catch (err) {
			if (generation === this.generation) {
				if (err instanceof StaleWriteError) this.stale = true;
				else this.saveError = err instanceof Error ? err.message : String(err);
			}
			throw err;
		}
	}

	/**
	 * Drops the unsaved text (the banner's Reload, or the agent's "Discard
	 * mine"). With a tab open it shows the stored text it had at once, so
	 * typing while the file loads again starts from it, not from the dropped
	 * text; with none, the document goes, and the next tab loads the stored
	 * file. A stale document reads the server's copy as it is now, not the
	 * view's cached copy, which is older when another tab or a teammate
	 * changed the file. Its version is behind the file's, since the refused
	 * save counted, so a save of typing that landed during the read is
	 * refused too. The saves waiting their turn are dropped with the text.
	 */
	async discard(): Promise<void> {
		// step: before anything awaits
		this.generation += 1;
		const fresh = this.stale;
		this.stale = false;
		if (fresh) this.view.invalidate(this.path);
		if (this.tabs === 0) {
			this.markDirty(false);
			this.changed();
			return;
		}
		this.markDirty(false);
		if (this.base !== null) this.apply(this.base);
		await this.load();
	}

	/** Brings this path's Monaco model to the document's text, before an editor binds to it. */
	syncModel(): void {
		if (this.text !== null) this.apply(this.text);
	}

	/**
	 * Sets the text, and the Monaco model with it; the editors' change events
	 * meanwhile are not typing.
	 *
	 * @param text - The stored text.
	 */
	private apply(text: string): void {
		this.text = text;
		this.applying = true;
		try {
			this.sync?.(text);
		} finally {
			this.applying = false;
		}
	}

	/**
	 * Marks the text unsaved or saved. The view hears each flip, since the
	 * agent reads the overlay; a saved document with no tab goes.
	 *
	 * @param next - True for unsaved.
	 */
	private markDirty(next: boolean): void {
		if (this.dirty === next) return;
		this.dirty = next;
		this.view.notify();
		if (!next && this.tabs === 0) this.releaseIfIdle();
	}

	/**
	 * Drops a document no tab shows, no unsaved text keeps and no load is on
	 * its way to. A save of it waiting its turn finds nothing unsaved, so it
	 * writes nothing and resolves: the stored file holds the text.
	 */
	private releaseIfIdle(): void {
		if (this.tabs > 0 || this.dirty || this.loading > 0) return;
		const shelved = shelf(this.view);
		if (shelved.get(this.path) === this) shelved.delete(this.path);
		this.unregister?.();
		this.unregister = null;
		this.view.notify();
	}

	/** Tells the listeners. */
	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/**
 * The document of a path: the one its tabs share, or a new one, which every
 * tab of the path then finds.
 *
 * @param view - The workspace view.
 * @param path - The file's workspace path.
 * @returns The document; a tab joins it with open().
 */
export function fileDocument(view: IWorkspaceFileSystem, path: string): FileDocument {
	const shelved = shelf(view);
	let doc = shelved.get(path);
	if (!doc) {
		doc = new FileDocument(view, path);
		shelved.set(path, doc);
	}
	return doc;
}

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
// EDITOR CONTROLS — the open editors the agent's unsaved-changes prompt acts on
// =============================================================================

/**
 * When the agent wants to change a file with unsaved changes, the user can
 * answer "Save mine first" or "Discard mine", and the editors that hold the
 * file do it. Each open document registers here: a text file in Monaco tabs
 * (fileDocument.ts) and a pipeline on the canvas (canvasDocument.ts). Splits
 * of one document share one registration. One path can have two: a text tab
 * and a canvas on the same .pipe. A registration lives while a tab shows its
 * document, and after the last tab closes for as long as its unsaved text
 * does (the Monaco model and Documents both keep it), so the agent still
 * asks about it.
 *
 * Every path with editors has one overlay on the view that stands for all of
 * them: the path is dirty while any of its editors is, and readers get the
 * first dirty editor's buffer. An editor itself loads the stored file, past
 * every buffer (readVersioned's `stored`), so it never takes another
 * editor's unsaved changes for its clean content. Typing while an editor
 * loads, in it or in another editor, keeps the path dirty, so a rename or
 * the agent cannot act on the stored file meanwhile.
 * The agent's save and discard act on the editors that are dirty. Ctrl+S
 * saves only the active document's editor.
 */

import type { EditorControl } from 'shared/modules/agent/host';
import type { IWorkspaceFileSystem, VfsOverlay } from 'shared/modules/vfs/vfsTypes';

/** One open document of a path: its buffer for readers, and its save and discard. */
export interface EditorRegistration extends VfsOverlay, EditorControl {
	/** The document it holds: `file:<path>` for a text file, the pipeline's URI for a canvas. */
	uri: string;
}

/** The editors of one path, and the overlay that stands for them. */
interface PathEditors {
	editors: EditorRegistration[];
	unregister: () => void;
}

/** The mounted editors, by workspace view, then by path. */
const views = new WeakMap<IWorkspaceFileSystem, Map<string, PathEditors>>();

/**
 * Registers one editor of a path, and puts the path's overlay on the view if
 * it is the first.
 *
 * @param view - The workspace view the editor reads and saves through.
 * @param path - The workspace path ('apps/...', 'pipelines/...').
 * @param editor - The editor's buffer, save and discard.
 * @returns Unregisters this editor only; the overlay goes with the path's last editor.
 */
export function registerEditor(view: IWorkspaceFileSystem, path: string, editor: EditorRegistration): () => void {
	let paths = views.get(view);
	if (!paths) {
		paths = new Map();
		views.set(view, paths);
	}
	let entry = paths.get(path);
	if (!entry) {
		const editors: EditorRegistration[] = [];
		const overlay: VfsOverlay = {
			getContent: () => (editors.find((e) => e.isDirty()) ?? editors[0])?.getContent(),
			isDirty: () => editors.some((e) => e.isDirty()),
		};
		entry = { editors, unregister: view.registerOverlay(path, overlay) };
		paths.set(path, entry);
	}
	const mine = entry;
	mine.editors.push(editor);
	return () => {
		const at = mine.editors.indexOf(editor);
		if (at >= 0) mine.editors.splice(at, 1);
		if (mine.editors.length > 0 || paths.get(path) !== mine) return;
		mine.unregister();
		paths.delete(path);
	};
}

/**
 * The editors that hold a path, as one control for the agent's question:
 * save and discard act on each editor that is dirty when its turn comes.
 *
 * @param view - The workspace view.
 * @param path - The workspace path.
 * @returns The control, or null when no editor is mounted for the path.
 */
export function editorControl(view: IWorkspaceFileSystem, path: string): EditorControl | null {
	const editors = views.get(view)?.get(path)?.editors;
	if (!editors || editors.length === 0) return null;
	const each = async (act: (editor: EditorRegistration) => Promise<void>): Promise<void> => {
		for (const editor of editors.filter((e) => e.isDirty())) if (editor.isDirty()) await act(editor);
	};
	return { save: () => each((editor) => editor.save()), discard: () => each((editor) => editor.discard()) };
}

/**
 * Saves the editor of one document, the one Ctrl+S is pressed in, and no
 * other editor of its path: a text tab and a canvas on one .pipe each save
 * their own buffer. The editor shows a failed save itself (the banner, or the
 * pipeline's dialog), and the returned promise rejects with it.
 *
 * @param view - The workspace view.
 * @param uri - The document's URI.
 * @returns The save (resolved at once when the document has nothing unsaved), or null when no editor holds the document.
 */
export function saveDocumentEditor(view: IWorkspaceFileSystem, uri: string): Promise<void> | null {
	for (const entry of views.get(view)?.values() ?? []) {
		const editor = entry.editors.find((e) => e.uri === uri);
		if (editor) return editor.isDirty() ? editor.save() : Promise.resolve();
	}
	return null;
}

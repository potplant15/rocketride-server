// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * projectVfs — {@link IVirtualFileSystem} adapter over the server project
 * store.
 *
 * Bridges the shell's VFS vocabulary (the one the stock SaveFileDialog
 * browses) onto the projectStore helpers, which prepend PROJECT_DIR and talk
 * to the server over the client's fs* methods. This is the browser host's
 * "RocketVFS" — the VS Code host provides its own adapter over the workspace
 * folder.
 */

import type { RocketRideClient, IVirtualFileSystem } from 'shell';
import { scopedFileSystem } from 'shared/modules/vfs/scopedFileSystem';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { saveDocumentEditor } from '../../agent/editorControls';
import { getStagedWorkspace, getWorkspaceVfs } from './vfs/workspace';

/** The workspace mount that holds pipelines; project-store paths are relative to it. */
const PIPELINES_MOUNT = 'pipelines';

/**
 * The project-store VFS, plus the path versions of the workspace view: a
 * write may name the version it was computed from (see IWorkspaceFileSystem).
 */
export interface ProjectVfs extends IVirtualFileSystem {
	/**
	 * Writes a pipeline, serialized the way fsWriteJson does.
	 *
	 * @param path - Project-store path.
	 * @param content - The pipeline object.
	 * @param origin - The writer's identity.
	 * @param expect - The version the pipeline was loaded at; refused when the file moved on.
	 */
	write(path: string, content: unknown, origin?: string, expect?: number): Promise<void>;
	/**
	 * Reads a pipeline, with the version it belongs to (see IWorkspaceFileSystem.readVersioned).
	 *
	 * @param path - Project-store path.
	 * @param opts.stored - Read what is stored, never an editor's unsaved buffer.
	 */
	readVersioned(path: string, opts?: { stored?: boolean }): Promise<{ content: unknown; version: number }>;
	/** The path's version in the workspace view. */
	version(path: string): number;
}

/**
 * The workspace view path of a project-store path.
 *
 * @param path - Project-store path (e.g. 'chat.pipe').
 * @returns The view path (e.g. 'pipelines/chat.pipe').
 */
export function pipelineViewPath(path: string): string {
	return `${PIPELINES_MOUNT}/${path.replace(/^\/+/, '')}`;
}

/** The newest pipeline write called through a project VFS, whether it landed, and the path's version when it did. */
interface PipelineWrite {
	text: string;
	landed: boolean;
	version?: number;
}

/** Per workspace view, then per view path, the newest pipeline write (see pipelineWrites). */
const pipelineWritesByView = new WeakMap<IWorkspaceFileSystem, Map<string, PipelineWrite>>();

/**
 * The newest pipeline write called through a project VFS on each path of a
 * view. A write lands once the view keeps it: in auto mode the store holds
 * it, in manual mode the staging store does. Until then the view may hold
 * the text (a staged write is in the view before the staging store keeps
 * it, and stays there when that fails), but a reload would lose it.
 *
 * @param workspace - The workspace view.
 * @returns The writes, by view path.
 */
function pipelineWrites(workspace: IWorkspaceFileSystem): Map<string, PipelineWrite> {
	let writes = pipelineWritesByView.get(workspace);
	if (!writes) {
		writes = new Map();
		pipelineWritesByView.set(workspace, writes);
	}
	return writes;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds a project-store VFS bound to the shared workspace view.
 *
 * Routes through the staged workspace (pipelines mount) so staged
 * (uncommitted) pipeline edits are what consumers see — paths stay
 * relative to the project-store root, and read/write keep the parsed-JSON
 * contract (fsReadJson/fsWriteJson shapes). This is the ONLY pipeline
 * file adapter: every pipeline read/write in the app goes through it.
 *
 * The client may be null (not connected yet) — operations then reject with
 * "Not connected", which consumers surface inline (e.g. the save dialog's
 * tree notice) instead of crashing.
 *
 * @param client - The connected RocketRide client, or null.
 * @returns A VFS whose paths are relative to the project-store root.
 */
export function createProjectVfs(client: RocketRideClient | null): ProjectVfs {
	/** Throws the standard not-connected error when no client exists. */
	const requireConnected = (): void => {
		if (!client) throw new Error('Not connected');
	};
	// step: the pipelines mount of the shared staged view, project-relative
	const workspace = getWorkspaceVfs();
	const view = scopedFileSystem(workspace, PIPELINES_MOUNT);

	return {
		// Directory listing, normalized to the VFS { name, type } shape.
		list: async (dir: string) => {
			requireConnected();
			return view.list(dir);
		},
		// async so a requireConnected() failure REJECTS (the documented
		// contract) instead of throwing synchronously.
		read: async (path: string) => {
			requireConnected();
			return JSON.parse(String(await view.read(path)));
		},
		write: async (path: string, content: unknown, origin?: string, expect?: number) => {
			requireConnected();
			// step: mirror fsWriteJson's serialization exactly
			const text = JSON.stringify(content, null, 2);
			const mine: PipelineWrite = { text, landed: false };
			pipelineWrites(workspace).set(pipelineViewPath(path), mine);
			// step: the view counts the write's version when the write is called, so read it
			// before awaiting: mutations queued behind this one move the version meanwhile
			const writing = view.write(path, text, origin, expect);
			mine.version = view.version(path);
			await writing;
			mine.landed = true;
		},
		readVersioned: async (path: string, opts?: { stored?: boolean }) => {
			requireConnected();
			const { content, version } = await view.readVersioned(path, opts);
			return { content: JSON.parse(String(content)), version };
		},
		version: (path: string) => view.version(path),
		rename: async (oldPath: string, newPath: string) => {
			requireConnected();
			await view.rename(oldPath, newPath);
		},
		// Files AND directories: the view routes by actual kind (folders
		// remove recursively at the backend).
		delete: async (path: string) => {
			requireConnected();
			await view.delete(path);
		},
		mkdir: async (path: string) => {
			requireConnected();
			await view.mkdir(path);
		},
	};
}

// =============================================================================
// DOCUMENTS — the pipeline tabs' adapter, and the canvas save
// =============================================================================

/** The view version each pipeline object was read or saved at; Documents holds the object as it is. */
const loadedVersions = new WeakMap<object, number>();

/**
 * The version a pipeline Documents holds was read or saved at: the version
 * a canvas that mounts on it names in its next save, whatever the view's
 * version is by then.
 *
 * @param content - The pipeline object Documents holds.
 * @returns The version, or undefined for content this page did not read or save (typing, or content Documents restored).
 */
export function loadedVersion(content: unknown): number | undefined {
	return typeof content === 'object' && content !== null ? loadedVersions.get(content) : undefined;
}

/**
 * The content adapter Documents reads and writes pipeline tabs through: the
 * project VFS (the staged workspace view's pipelines mount), with the
 * Documents singleton's lenient error contract preserved for listing and
 * reads, which degrade to empty/null. Routing through the VIEW is what makes
 * staged (uncommitted) pipeline edits visible in tabs and keeps tab saves
 * from clobbering staged layers. Each read is of the stored pipeline, past
 * every editor's unsaved buffer: a text tab's typing on the same file stays
 * that tab's, and is not loaded as the canvas's clean content. Each read
 * notes the version it was taken at (see loadedVersion).
 *
 * A write of content a canvas save already landed is skipped: the canvas
 * saves through its own versioned write (savePipeline), then asks Documents
 * to mark the tab clean, which lands here with the same content. Writing it
 * again would be a second store write and a second version. Content the view
 * holds is not enough: a staged save is in the view before the staging store
 * keeps it, and stays there when that fails.
 *
 * Any other write is a save Documents asks for itself (the dirty-close
 * dialog's Save). The pipeline's canvas makes it: it names the version it
 * loaded, shows Reload or Overwrite when the pipeline moved on, and shows
 * any other failure. A save on its way is waited for. A save that did not
 * land rejects (one the user dropped while it waited its turn with
 * SaveDroppedError), so Documents keeps the tab open instead of closing it
 * as saved.
 *
 * @param client - The connected RocketRide client, or null.
 * @returns The adapter for `new Documents(...)`.
 */
export function createDocumentsVfs(client: RocketRideClient | null): IVirtualFileSystem {
	const projectVfs = createProjectVfs(client);
	return {
		list: async (dir: string) => {
			try {
				return await projectVfs.list(dir);
			} catch {
				return [];
			}
		},
		read: async (uri: string) => {
			try {
				const { content, version } = await projectVfs.readVersioned(uri, { stored: true });
				if (typeof content === 'object' && content !== null) loadedVersions.set(content, version);
				return content;
			} catch {
				return null;
			}
		},
		write: async (uri: string, content: unknown) => {
			if (!content) return;
			const text = JSON.stringify(content, null, 2);
			const path = pipelineViewPath(uri);
			// step: the newest write of the pipeline landed with this content, and nothing changed the path since
			// (a discard, or a later write of the same text that was not kept, moves its version)
			const saved = () => {
				const write = pipelineWrites(getWorkspaceVfs()).get(path);
				return write?.landed === true && write.version === projectVfs.version(uri) && write.text === text && getStagedWorkspace().heldContent(path) === text;
			};
			if (saved()) return;
			const saving = saveDocumentEditor(getWorkspaceVfs(), uri);
			if (!saving) throw new Error(`${uri} was not saved: no open canvas holds it, so its version cannot be checked.`);
			await saving;
			if (!saved()) throw new Error(`${uri} was not saved: the canvas did not save this content.`);
		},
		rename: (oldPath: string, newPath: string) => projectVfs.rename(oldPath, newPath),
		delete: (path: string) => projectVfs.delete(path),
		mkdir: (path: string) => projectVfs.mkdir(path),
	};
}

/**
 * Saves the pipeline a canvas holds: one write that names the version the
 * canvas loaded, then Documents marks the tab clean (its adapter skips the
 * same content, so the store is written once). Typing that landed while the
 * write was on its way is not what was written, so the tab stays dirty, and
 * so does a write that a discard or another write queued behind it overtook.
 *
 * @param projectVfs - The project VFS.
 * @param docs - The Documents instance holding the tab, or null.
 * @param saveFilename - The project-store path to write.
 * @param uri - The tab's document URI.
 * @param project - The pipeline.
 * @param expect - The version the canvas loaded; a pipeline that moved on refuses the write with StaleWriteError.
 * @returns The version of this write, the canvas's new loaded version.
 */
export async function savePipeline(projectVfs: ProjectVfs, docs: { getState(): { documents: Record<string, { content: unknown } | undefined> }; saveDocument(uri: string): Promise<void> } | null, saveFilename: string, uri: string, project: unknown, expect: number): Promise<number> {
	const writing = projectVfs.write(saveFilename, project, 'editor', expect);
	const mine = projectVfs.version(saveFilename);
	await writing;
	if (typeof project === 'object' && project !== null) loadedVersions.set(project, mine);
	const written = JSON.stringify(project, null, 2);
	// step: a mutation queued behind this write (a discard, another write) moved the path on, so this
	// save is not what the path holds: the tab stays dirty. Marking it clean would land in the adapter,
	// which would find no kept write and ask this canvas to save, waiting on this very save.
	if (projectVfs.version(saveFilename) !== mine) return mine;
	if (docs && JSON.stringify(docs.getState().documents[uri]?.content, null, 2) === written) await docs.saveDocument(uri);
	return mine;
}

/**
 * Reloads the pipeline a canvas holds: Documents reads it again through the
 * adapter, past every editor's unsaved buffer (the canvas's own, and a text
 * tab's on the same file), and marks the tab clean.
 *
 * @param docs - The Documents instance holding the tab, or null.
 * @param uri - The tab's document URI.
 * @returns The version the reloaded content belongs to, or null when nothing reloaded: the adapter reads a pipeline that is gone or not valid JSON as null, and Documents then keeps the old content, so the canvas must keep its old version too. So does typing that landed during the read, which Documents keeps over the read.
 */
export async function reloadPipeline(docs: { getState(): { documents: Record<string, { version: number; dirty: boolean; content: unknown } | undefined> }; revertDocument(uri: string): Promise<void> } | null, uri: string): Promise<number | null> {
	if (!docs) return null;
	const before = docs.getState().documents[uri]?.version;
	await docs.revertDocument(uri);
	// step: Documents counts a reload only when its read gave content, and leaves the document clean only when it applied it
	const after = docs.getState().documents[uri];
	return after !== undefined && after.version !== before && !after.dirty ? (loadedVersion(after.content) ?? null) : null;
}

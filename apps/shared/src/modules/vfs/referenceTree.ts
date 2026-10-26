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
// REFERENCE TREE — the read-only .rocketride/ folder's layout and file tree
// =============================================================================

/**
 * RocketRide's reference files appear in the workspace as a read-only
 * top-level folder, `.rocketride/`, next to the folders the user owns. Its
 * files come from the connected server, never from the user's store; the host
 * fetches them and hands the file set to a ReferenceTree, which lists and
 * reads it. This file owns the layout: where a server docs-bundle entry is
 * served, and which entries are not served. It is pure, so every host and the
 * tests can share it.
 */

// =============================================================================
// LAYOUT
// =============================================================================

/** The read-only top-level folder RocketRide's reference files are served under. */
export const ROCKETRIDE_ROOT = '.rocketride';

/**
 * Guides in the docs bundle that are not served. README and CLI teach a shell
 * and python_API a Python runtime, and the browser has neither. The builder
 * prompt's router replaces the README's task router.
 */
const HIDDEN_GUIDES = new Set(['ROCKETRIDE_README.md', 'ROCKETRIDE_CLI.md', 'ROCKETRIDE_python_API.md']);

/**
 * Where a docs.zip entry is served below ROCKETRIDE_ROOT: a root-level .md
 * becomes 'docs/<name>'. stubs/, manifest.json and the hidden guides (README,
 * CLI, python_API) are not served.
 *
 * @param entry - An entry name in the server's docs bundle, e.g. 'ROCKETRIDE_APPS.md'.
 * @returns The path below ROCKETRIDE_ROOT (e.g. 'docs/ROCKETRIDE_APPS.md'), or null when the entry is not served.
 */
export function docsPathFor(entry: string): string | null {
	if (entry.includes('/') || !entry.endsWith('.md') || HIDDEN_GUIDES.has(entry)) return null;
	return `docs/${entry}`;
}

/**
 * Whether a workspace path is ROCKETRIDE_ROOT or under it.
 *
 * @param path - A canonical workspace path.
 * @returns True for the reference folder and everything in it.
 */
export function isReferencePath(path: string): boolean {
	return path === ROCKETRIDE_ROOT || path.startsWith(`${ROCKETRIDE_ROOT}/`);
}

// =============================================================================
// THE TREE
// =============================================================================

/** A read-only file tree, by path below its root. */
export class ReferenceTree {
	/** The folder it is served under (for messages). */
	private readonly root: string;
	/** Text by path below the root. */
	private readonly files: ReadonlyMap<string, string>;
	/** Every folder the file paths imply, '' (the root) included. */
	private readonly dirs = new Set<string>(['']);

	/**
	 * @param root - The folder it is served under (for messages).
	 * @param files - Text by path below it, e.g. 'docs/ROCKETRIDE_APPS.md'.
	 */
	constructor(root: string, files: ReadonlyMap<string, string>) {
		this.root = root;
		this.files = files;
		for (const path of files.keys()) {
			for (let cut = path.indexOf('/'); cut > 0; cut = path.indexOf('/', cut + 1)) this.dirs.add(path.slice(0, cut));
		}
	}

	/**
	 * Lists one folder, its folders built from the file set.
	 *
	 * @param rel - The folder below the root ('' = the root).
	 * @returns Its entries, sorted by name.
	 * @throws For a file, or a folder that does not exist.
	 */
	list(rel: string): Array<{ name: string; type: 'file' | 'dir' }> {
		if (this.files.has(rel)) throw new Error(`${this.workspacePath(rel)} is a file, not a folder.`);
		if (!this.dirs.has(rel)) throw new Error(`No folder at ${this.workspacePath(rel)}.`);
		const prefix = rel ? `${rel}/` : '';
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
		}
		return [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, type]) => ({ name, type }));
	}

	/**
	 * Reads one file.
	 *
	 * @param rel - The file below the root.
	 * @returns Its text.
	 * @throws For a folder, or for a miss, naming every file that exists.
	 */
	read(rel: string): string {
		const text = this.files.get(rel);
		if (text !== undefined) return text;
		if (this.dirs.has(rel)) throw new Error(`${this.workspacePath(rel)} is a folder, not a file.`);
		const files = [...this.files.keys()].map((path) => this.workspacePath(path));
		throw new Error(`No file at ${this.workspacePath(rel)}.${files.length > 0 ? ` Files: ${files.join(', ')}` : ''}`);
	}

	/** The workspace path of a path below the root. */
	private workspacePath(rel: string): string {
		return rel ? `${this.root}/${rel}` : this.root;
	}
}

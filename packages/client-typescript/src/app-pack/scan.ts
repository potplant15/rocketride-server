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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * App discovery — resolves `.rrapp` markers to app working copies (Node.js
 * only).
 *
 * Discovery is `.rrapp`-driven: every `<folder>/<name>.rrapp` marker names a
 * candidate folder, and the package.json NEXT TO the marker must verify the
 * folder as one of our apps via its `appManifest` block (binding key:
 * appManifest.id — "bind, don't sync": the file system is the single source
 * of truth; this module only READS). Folders without a marker are never
 * listed, no matter what their package.json declares.
 *
 * FINDING the markers is the host's job (the VS Code extension uses its
 * workspace index, honoring files.exclude); this module owns everything
 * after: probing, ordering, and first-binding-wins dedup.
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// TYPES
// =============================================================================

/** One app project found in the workspace. */
export interface ScannedApp {
	/** appManifest.id (e.g. 'acme.brandy'). */
	id: string;
	/** Display name (appManifest.name, falling back to the package name). */
	name: string;
	/** MF container name (dots/hyphens → underscores, as registerApp derives). */
	moduleId: string;
	/** Absolute folder path of the app project. */
	folder: string;
	/** package.json version, if present. */
	version?: string;
	/** appManifest.description, if present. */
	description?: string;
	/** Absolute path of the app's icon file (appManifest.icon), when declared and readable. */
	icon?: string;
}

// =============================================================================
// SCAN
// =============================================================================

/**
 * Reads one candidate folder's package.json and returns its ScannedApp when
 * it carries an appManifest block with an id — the check that verifies a
 * marker's folder really is one of our apps.
 *
 * @param folder - Absolute folder path to probe.
 * @returns The scanned app, or null when this folder is not an app project.
 */
export async function probeAppFolder(folder: string): Promise<ScannedApp | null> {
	try {
		// Read + parse the candidate package.json
		const raw = await fs.promises.readFile(path.join(folder, 'package.json'), 'utf8');
		const pkg = JSON.parse(raw) as {
			name?: string;
			version?: string;
			appManifest?: { id?: string; name?: string; description?: string; icon?: string };
		};
		const manifest = pkg.appManifest;
		if (!manifest?.id) return null;

		// Resolve the declared icon against the app folder; drop it when the
		// file does not actually exist so consumers can trust the path.
		let icon: string | undefined;
		if (manifest.icon) {
			const iconPath = path.join(folder, manifest.icon);
			if (fs.existsSync(iconPath)) icon = iconPath;
		}

		return {
			id: manifest.id,
			name: manifest.name || pkg.name || manifest.id,
			moduleId: manifest.id.replace(/[.-]/g, '_'),
			folder,
			version: pkg.version,
			description: manifest.description,
			icon,
		};
	} catch {
		// Missing/unreadable/invalid package.json — not an app project
		return null;
	}
}

/**
 * Resolves `.rrapp` marker paths to the app working copies they bind.
 *
 * Each marker's folder is a candidate, and its adjacent package.json must
 * verify the folder as one of our apps (an appManifest block with an id).
 * Deduplicated by app id, with the shallowest marker winning (the least
 * nested working copy is the canonical binding). The server catalog is
 * never consulted.
 *
 * @param markerPaths - Absolute paths of every `.rrapp` marker found, in
 *   any order.
 * @returns All bound app projects, shallowest binding per app id.
 */
export async function scanAppMarkers(markerPaths: string[]): Promise<ScannedApp[]> {
	// step: shallowest first — the dedup below keeps the FIRST hit per app id
	const depth = (p: string): number => path.resolve(p).split(/[\\/]/).length;
	const sorted = [...markerPaths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

	// step: one probe per marker folder (a folder holding several markers probes once)
	const folders: string[] = [];
	const seenFolders = new Set<string>();
	for (const marker of sorted) {
		const folder = path.dirname(path.resolve(marker));
		if (!seenFolders.has(folder)) {
			seenFolders.add(folder);
			folders.push(folder);
		}
	}

	// step: probed concurrently; Promise.all preserves candidate order, so
	// first-binding-per-app-id-wins is deterministic
	const probed = await Promise.all(folders.map((folder) => probeAppFolder(folder)));
	const found = new Map<string, ScannedApp>();
	for (const app of probed) {
		if (app && !found.has(app.id)) found.set(app.id, app);
	}
	return [...found.values()];
}

// =============================================================================
// ICON
// =============================================================================

/**
 * Icon size ceiling for the data: URI conversion. The manifest can point at
 * an arbitrarily large file; base64-inlining it would balloon every message
 * that carries it, so anything above this falls back to the generic glyph.
 */
export const MAX_ICON_BYTES = 256 * 1024;

/**
 * Size ceiling for README-inlined images. Screenshots and GIFs are
 * legitimately far larger than icons, so the README preview gets its own
 * budget; anything above it keeps its original (broken) reference.
 */
export const MAX_README_IMAGE_BYTES = 10 * 1024 * 1024;

/** Media type per icon file extension the app store accepts. */
const ICON_MEDIA_TYPES: Record<string, string> = {
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

/**
 * Converts an icon file to a data: URI — what `register_dev` carries to the
 * server and what webviews render without widening their resource roots.
 *
 * @param iconPath - Absolute icon file path (e.g. {@link ScannedApp.icon}).
 * @param maxBytes - Size ceiling for the conversion; larger files return
 *                   undefined. Defaults to the icon budget.
 * @returns The data: URI, or undefined when absent/unreadable/unknown type.
 */
export async function appIconDataUri(iconPath: string | undefined, maxBytes: number = MAX_ICON_BYTES): Promise<string | undefined> {
	if (!iconPath) return undefined;
	try {
		// Media type from the extension; unknown types get the generic glyph.
		const mediaType = ICON_MEDIA_TYPES[path.extname(iconPath).toLowerCase()];
		if (!mediaType) return undefined;

		// Stat before reading: the manifest can point at an arbitrarily large
		// file, and only this size gate keeps the data: URI bounded.
		const stat = await fs.promises.stat(iconPath);
		if (stat.size > maxBytes) return undefined;

		const bytes = await fs.promises.readFile(iconPath);
		return `data:${mediaType};base64,${bytes.toString('base64')}`;
	} catch {
		// Unreadable icon — the row falls back to the generic glyph
		return undefined;
	}
}

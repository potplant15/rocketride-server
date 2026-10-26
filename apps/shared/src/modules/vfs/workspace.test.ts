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
// WORKSPACE TESTS — rocket-ui's real workspace end to end: team switch, timed-out calls, canvas saves and editor documents
// =============================================================================

/**
 * These tests run rocket-ui's workspace (workspace.ts: its store backend,
 * CachedVfs and the staged view) over a fake store client, the only place
 * the whole stack runs in a test. The client is the one the shell stub's
 * getClient() hands out (scripts/stub-shell.cjs). The editor documents
 * (fileDocument.ts, canvasDocument.ts) hold what the Monaco tab and the
 * canvas share across splits; a text file's also outlives its last tab while
 * its text is unsaved. They are loaded with import() so the tests of Ctrl+S
 * also run on a tree that does not have them.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { Documents } from 'shell/src/components/docs/Documents';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';

import * as controls from '../../../../rocket-ui/src/agent/editorControls';
import { editorControl, registerEditor } from '../../../../rocket-ui/src/agent/editorControls';
import type { CanvasDocs } from '../../../../rocket-ui/src/surfaces/pipelines/canvasDocument';
import { appPath, readAppImageDataUri, readAppPackage, readAppText, scaffoldApp } from '../../../../rocket-ui/src/surfaces/preview/session/appStore';
import { prepareDependencies } from '../../../../rocket-ui/src/surfaces/preview/session/deps';
import { createWebAppBuilderHost } from '../../../../rocket-ui/src/surfaces/preview/session/webHost';
import { createDocumentsVfs, createProjectVfs, reloadPipeline, savePipeline } from '../../../../rocket-ui/src/surfaces/workspace/projectVfs';
import { createWorkspace, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import type { ChatAskAnswer, ChatAskCard, ChatAsking } from 'shell/src/components/chat/types';
import { SaveDroppedError, type AgentHost } from '../agent/host';
import { BUILDER_PROMPTS } from '../agent/prompts';
import { CheckRecord, runAgent } from '../agent/run';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import type { AgentTool } from '../agent/tools';
import { runLoop } from '../agent/wave/loop';
import { StagedFileSystem, StaleVersionError, StaleWriteError } from './stagedFileSystem';
import { StagingStore } from './staging';

// =============================================================================
// HARNESS
// =============================================================================

/**
 * Calls a tool the way the loop does when it lets every act through: it gets
 * the call ready, then runs its step.
 *
 * @param tool - The tool.
 * @param args - The call's arguments.
 * @returns The tool result.
 */
async function callTool(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
	return (await tool.prepare(args)).run();
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

/** A reply asking for one tool call. */
function plan(tool: string, args: unknown): string {
	return JSON.stringify({ tool_calls: [{ tool, args }] });
}

/** Ends a scripted model run. */
function boundedStop(): never {
	throw new Error('bounded test stop');
}

/** Counts workspaces, so each test roots its own in teams no other test used. */
let teams = 0;

/**
 * A fake store with one app file in each of two teams, as the store client
 * the workspace talks to.
 *
 * @returns The client, its files, the store paths written in order, and the team ids and file paths.
 */
function storage() {
	teams += 1;
	const [alpha, beta] = [`alpha${teams}`, `beta${teams}`];
	const files = new Map<string, string>();
	const writes: string[] = [];
	const a = `@/Team/=${alpha}/.projects/.appdev/probe.txt`;
	const b = `@/Team/=${beta}/.projects/.appdev/probe.txt`;
	files.set(a, 'const probe = 1;');
	files.set(b, 'const probe = 900;');
	const client = {
		fsReadJson: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return JSON.parse(files.get(path) as string);
		},
		fsWriteJson: async (path: string, value: unknown) => {
			files.set(path, JSON.stringify(value));
		},
		fsReadString: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return files.get(path) as string;
		},
		fsWriteString: async (path: string, value: string) => {
			files.set(path, value);
			writes.push(path);
		},
		fsReadMany: async (paths: string[]) => paths.map((path) => (files.has(path) ? { ok: true, data: new TextEncoder().encode(files.get(path)) } : { ok: false })),
		fsListDir: async () => ({ entries: [] }),
		fsStat: async () => ({ type: 'file' }),
		fsDelete: async (path: string) => {
			files.delete(path);
		},
		fsRename: async (from: string, to: string) => {
			if (!files.has(from)) throw new Error(`File not found: ${from}`);
			files.set(to, files.get(from) as string);
			files.delete(from);
			writes.push(to);
		},
		fsRmdir: async () => undefined,
		fsMkdir: async () => undefined,
	};
	(globalThis as { __shellTestClient?: unknown }).__shellTestClient = client;
	return { client, files, writes, alpha, beta, a, b };
}

/** The paths a team's staging manifest names, which is what a reload restores. */
function manifestPaths(s: ReturnType<typeof storage>, teamId: string): string[] {
	const manifest = JSON.parse(s.files.get(`.staging/workspace.test/team-${teamId}/manifest.json`) as string) as { layers: Array<{ entries: Record<string, unknown> }> };
	return manifest.layers.flatMap((layer) => Object.keys(layer.entries)).sort();
}

/**
 * A second tab's view of a team: its own staged view and staging store over
 * the same staging namespace. Its base sees no files, which staging does not need.
 */
async function otherTab(teamId: string): Promise<StagedFileSystem> {
	const blank = { list: async () => [], read: async () => Promise.reject(new Error('File not found')), write: async () => undefined, rename: async () => undefined, delete: async () => undefined, mkdir: async () => undefined };
	const view = new StagedFileSystem(new CachedVfs(blank), new StagingStore('workspace.test', `team-${teamId}`));
	await view.whenReady();
	return view;
}

/** The workspace of a team, built the way RocketApp's bootstrap builds it (auto mode unless told). */
function workspace(teamId: string, autoCommit = true): Promise<Workspace> {
	return createWorkspace({ hostAppId: 'workspace.test', autoCommit, scope: { kind: 'team', teamId } });
}

/** The same in manual mode: changes stay staged until Commit all. */
function manualWorkspace(teamId: string): Promise<Workspace> {
	return workspace(teamId, false);
}

/** An agent host over a view, as createRocketAgentHost binds one. */
function host(vfs: Workspace['view']): AgentHost {
	return { vfs, scaffoldApp: async () => ({ appId: 'unused', folder: 'unused' }), packApp: async () => new Uint8Array(), devSession: () => null };
}

/** What runAgent is asked with: a turn nobody stops and no messages sent during it. */
function options() {
	return { history: [], prompts: BUILDER_PROMPTS, token: async () => '', signal: new AbortController().signal, takeQueued: () => [] };
}

/**
 * Holds the store's next read of a path once it has the content, so the read
 * comes back with the file as it was when it was made.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns Settles once the read is held, and lets it come back.
 */
function holdRead(s: ReturnType<typeof storage>, path: string): { held: Promise<void>; release: () => void } {
	const [held, landing] = [deferred(), deferred()];
	const read = s.client.fsReadString;
	s.client.fsReadString = async (p: string) => {
		const content = await read(p);
		if (p === path) {
			s.client.fsReadString = read;
			held.resolve();
			await landing.promise;
		}
		return content;
	};
	return { held: held.promise, release: landing.resolve };
}

/**
 * Holds the store's next write of a path until the test lets it land.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns Settles once the write is held, and lets it land.
 */
function holdWrite(s: ReturnType<typeof storage>, path: string): { held: Promise<void>; release: () => void } {
	const [held, landing] = [deferred(), deferred()];
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (p: string, value: string) => {
		if (p === path) {
			s.client.fsWriteString = write;
			held.resolve();
			await landing.promise;
		}
		return write(p, value);
	};
	return { held: held.promise, release: landing.resolve };
}

// =============================================================================
// TEAM SWITCH
// =============================================================================

test('a write in flight when the team changes lands in the team it started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	let reads = 0;
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		// step: hold the write's freshness check, after the agent decided to write
		if (path === s.a && ++reads === 2) {
			entered.resolve();
			await release.promise;
		}
		return value;
	};
	let calls = 0;
	const pending = runAgent('edit', () => undefined, options(), {
		host: host(old.view),
		client: () => null,
		markers: async () => null,
		model: async () => {
			switch (++calls) {
				case 1:
					return plan('read_file', { path: 'apps/probe.txt' });
				case 2:
					return plan('edit_file', { path: 'apps/probe.txt', oldString: '1', newString: '2' });
				default:
					return boundedStop();
			}
		},
	});
	await entered.promise;
	const fresh = await workspace(s.beta);
	assert.notEqual(old.view, fresh.view);
	release.resolve();
	await pending;
	assert.equal(s.files.get(s.a), 'const probe = 2;', 'the write landed in the team the run started in');
	assert.equal(s.files.get(s.b), 'const probe = 900;', 'the other team is untouched');
	assert.ok(!s.writes.includes(s.b));
});

test("a write started after the team changes stays staged in the old team's workspace", async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	let calls = 0;
	await runAgent('edit', () => undefined, options(), {
		host: host(old.view),
		client: () => null,
		markers: async () => null,
		model: async () => {
			switch (++calls) {
				case 1:
					return plan('read_file', { path: 'apps/probe.txt' });
				case 2:
					await workspace(s.beta);
					return plan('edit_file', { path: 'apps/probe.txt', oldString: '1', newString: '2' });
				default:
					return boundedStop();
			}
		},
	});
	assert.equal(s.files.get(s.a), 'const probe = 1;');
	assert.equal(s.files.get(s.b), 'const probe = 900;');
	assert.equal(await old.view.read('apps/probe.txt'), 'const probe = 2;');
});

test('a delete the user approves after the team changed lands in the team the run started in', async () => {
	const s = storage();
	// step: list each folder's files, so the delete finds the file it removes
	const listing = async (dir: string) => ({ entries: [...s.files.keys()].filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map((path) => ({ name: path.slice(dir.length + 1), type: 'file' as const })) });
	(s.client as { fsListDir: typeof listing }).fsListDir = listing;
	const old = await workspace(s.alpha);
	const asked = deferred();
	let answer: (value: ChatAskAnswer) => void = () => undefined;
	const cards: ChatAskCard[] = [];
	const ask = (card: ChatAskCard): ChatAsking => {
		cards.push(card);
		asked.resolve();
		return { answer: new Promise<ChatAskAnswer>((settle) => (answer = settle)), approve: () => answer('approve') };
	};
	let calls = 0;
	const pending = runAgent(
		'delete it',
		() => undefined,
		{ ...options(), ask },
		{
			host: host(old.view),
			client: () => null,
			markers: async () => null,
			model: async () => (++calls === 1 ? plan('delete_file', { path: 'apps/probe.txt' }) : boundedStop()),
		}
	);
	// step: the card waits; the user switches team, then approves
	await asked.promise;
	const fresh = await workspace(s.beta);
	answer('approve');
	await pending;
	assert.equal(cards.length, 1);
	// step: the switch parked the old workspace in manual mode, so the delete is staged there
	assert.equal(await old.view.stat('apps/probe.txt'), null, "the delete landed in the old team's workspace");
	assert.ok(old.view.changedPaths().has('apps/probe.txt'));
	assert.equal(await fresh.view.read('apps/probe.txt'), 'const probe = 900;', "the new team's file is still there");
	assert.equal(fresh.view.changedPaths().size, 0);
	// step: back in the first team, the staged delete is pending there and its commit removes that team's file
	const back = await workspace(s.alpha);
	assert.equal(back.view, old.view);
	await back.view.commit();
	assert.equal(s.files.has(s.a), false, 'the commit deleted the file in the team the run started in');
	assert.equal(s.files.get(s.b), 'const probe = 900;', 'the other team is untouched');
});

test("a change staged in the old team's workspace after the switch is announced under the old team's path", async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	const announced: string[] = [];
	(globalThis as { __shellTestEmit?: unknown }).__shellTestEmit = (_topic: string, event: { uri: string }) => announced.push(event.uri);
	try {
		await old.view.write('apps/probe.txt', 'const probe = 3;', 'agent');
	} finally {
		delete (globalThis as { __shellTestEmit?: unknown }).__shellTestEmit;
	}
	// step: the new team's dev previews and rescans never hear of a file they do not have
	assert.deepEqual(announced, [s.a]);
});

test('an app the agent scaffolds after the team changes is created in the team the run started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	// step: the scaffold names the preview URL from the page's origin
	(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' } };
	try {
		await scaffoldApp({ appName: 'late', displayName: 'Late', publisher: 'local', frame: { sidebar: false, statusFooter: false, docTabs: false } }, old);
	} finally {
		delete (globalThis as { window?: unknown }).window;
	}
	assert.ok(old.view.changedPaths().has('apps/late-ui/package.json'), "the scaffold is staged in the old team's workspace");
	assert.deepEqual(
		s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
		[],
		'nothing was written to the new team'
	);
});

test('a change an old call stages after the user switches away and back is kept', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await workspace(s.beta, false);
	const back = await workspace(s.alpha, false);
	// step: the old run's late write lands after the return, then the user edits in the same team
	await old.view.write('apps/late.txt', 'late agent content', 'agent');
	assert.ok(back.view.changedPaths().has('apps/late.txt'), 'the late change shows as pending');
	await back.view.write('apps/new.txt', 'new editor content', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/late.txt', 'apps/new.txt']);
});

test('going back to a team keeps a change another tab staged there meanwhile', async () => {
	const s = storage();
	await workspace(s.alpha, false);
	await workspace(s.beta, false);
	await (await otherTab(s.alpha)).write('apps/other.txt', 'saved in the other tab', 'editor');
	const back = await workspace(s.alpha, false);
	assert.ok(back.view.changedPaths().has('apps/other.txt'), "the other tab's change shows as pending");
	await back.view.write('apps/current.txt', 'saved here', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/current.txt', 'apps/other.txt']);
});

test('going back to a team does not bring back a change another tab discarded meanwhile', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await old.view.write('apps/draft.txt', 'staged before the switch', 'editor');
	await workspace(s.beta, false);
	await (await otherTab(s.alpha)).discard();
	const back = await workspace(s.alpha, false);
	assert.equal(back.view.changedPaths().has('apps/draft.txt'), false);
	await back.view.write('apps/current.txt', 'saved here', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/current.txt']);
});

test('a read still on its way when the user leaves a team cannot bring back an older file after a save there', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		if (path === s.a) {
			entered.resolve();
			await release.promise;
		}
		return value;
	};
	const pending = old.view.read('apps/probe.txt');
	await entered.promise;
	await workspace(s.beta);
	const back = await workspace(s.alpha);
	s.client.fsReadString = read;
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 1;');
	await back.view.write('apps/probe.txt', 'const probe = 2;', 'editor');
	release.resolve();
	// step: the return dropped the cache while the old read was on its way, so the view takes the file again
	assert.equal(await pending, 'const probe = 2;', 'the old read returns the saved file');
	assert.equal(s.files.get(s.a), 'const probe = 2;');
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 2;', 'the saved file, not the old read, is what the cache serves');
});

test('a read still on its way when its folder is deleted or renamed cannot put the old file back in the cache', async () => {
	for (const change of ['delete', 'rename'] as const) {
		const files = new Map([['src/a.ts', 'value = 1']]);
		const entered = deferred();
		const release = deferred();
		const move = async (from: string, to?: string): Promise<void> => {
			for (const [path, text] of [...files]) {
				if (path !== from && !path.startsWith(`${from}/`)) continue;
				files.delete(path);
				if (to !== undefined) files.set(`${to}${path.slice(from.length)}`, text);
			}
		};
		const cache = new CachedVfs({
			list: async () => [],
			read: async (path) => {
				const text = files.get(path);
				entered.resolve();
				await release.promise;
				if (text === undefined) throw new Error(`No file ${path}`);
				return text;
			},
			write: async (path, content) => void files.set(path, String(content)),
			rename: (from, to) => move(from, to),
			delete: (path) => move(path),
			mkdir: async () => undefined,
		});
		const pending = cache.read('src/a.ts');
		await entered.promise;
		if (change === 'delete') await cache.delete('src');
		else await cache.rename('src', 'lib');
		release.resolve();
		assert.equal(await pending, 'value = 1', `${change}: the old read returns what it read`);
		assert.equal(cache.cachedContent('src/a.ts'), undefined, `${change}: the cache does not keep a file its folder took away`);
		await assert.rejects(cache.read('src/a.ts'), /No file src\/a\.ts/, `${change}: a later read asks the store, which no longer has the file`);
	}
});

// =============================================================================
// READ-ONLY GUIDES — .rocketride/ in kept and reopened workspaces
// =============================================================================

test("the read-only guides read, and refuse changes, in each team's workspace, a run's old one and a reopened one", async () => {
	const s = storage();
	// step: the server's docs bundle, zipped with the fflate rocket-ui unzips it with
	const { zipSync, strToU8 } = createRequire(resolve(__dirname, '../../../../rocket-ui/package.json'))('fflate') as { zipSync: (files: Record<string, Uint8Array>) => Uint8Array; strToU8: (text: string) => Uint8Array };
	const bundle = zipSync({ 'ROCKETRIDE_APPS.md': strToU8('# Apps guide'), 'ROCKETRIDE_README.md': strToU8('# hidden') });
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		if (String(url) !== '/client/docs') throw new Error(`unexpected fetch ${url}`);
		return new Response(new Blob([new Uint8Array(bundle)]), { status: 200, headers: { 'content-type': 'application/zip' } });
	}) as unknown as typeof fetch;
	const guide = '.rocketride/docs/ROCKETRIDE_APPS.md';
	try {
		const old = await workspace(s.alpha, false);
		assert.equal(await old.view.read(guide), '# Apps guide');
		const fresh = await workspace(s.beta, false);
		const back = await workspace(s.alpha, false);
		assert.equal(back.view, old.view, 'going back reopened the kept workspace');
		// step: the reopened view dropped its cache and walked the tree again, guides included
		assert.ok((await back.view.list('.rocketride/docs')).some((entry) => entry.name === 'ROCKETRIDE_APPS.md'));
		assert.equal(await back.view.read(guide), '# Apps guide');
		assert.equal(await fresh.view.read(guide), '# Apps guide');
		// step: every change to a guide is refused before it stages, in each view, and none reaches the store
		for (const view of [old.view, fresh.view]) {
			await assert.rejects(view.write(guide, 'changed'), /^Error: \.rocketride\/ is read-only reference\. Write under apps\/, nodes\/ or pipelines\/\.$/);
			await assert.rejects(view.delete(guide), /read-only reference/);
			await assert.rejects(view.rename(guide, 'apps/guide.md'), /read-only reference/);
		}
		// step: the agent's own write, after it read the guide, as a run bound to the old team makes it
		const files = new FilesystemTools(old.view);
		const tool = (name: string) => files.tools().find((t) => t.name === name)!;
		assert.match(await (await tool('read_file').prepare({ path: guide })).run(), /# Apps guide/);
		await assert.rejects(async () => (await tool('write_file').prepare({ path: guide, content: 'changed' })).run(), /read-only reference/);
		assert.equal(old.view.hasPendingChanges(), false, 'nothing was staged');
		assert.deepEqual(
			s.writes.filter((path) => path.includes('.rocketride')),
			[],
			'nothing was written to the store'
		);
		assert.equal(await back.view.read(guide), '# Apps guide');
	} finally {
		globalThis.fetch = realFetch;
	}
});

// =============================================================================
// PREVIEW
// =============================================================================

test('a dependency version the preview settles after the team changes is locked in the team it started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		// step: hold the version lookup; the module graph is not needed here
		if (String(url).endsWith('/package.json')) {
			entered.resolve();
			await release.promise;
			return { ok: true, json: async () => ({ version: '1.2.3' }) };
		}
		throw new Error('no module graph in this test');
	}) as unknown as typeof fetch;
	try {
		const pending = prepareDependencies('same-ui', 'local.same', { dependencies: { example: '^1' } }, {}, old.view);
		await entered.promise;
		const fresh = await workspace(s.beta);
		release.resolve();
		await pending;
		const lock = 'apps/same-ui/rr-lock.json';
		assert.equal(JSON.parse(String(await old.view.read(lock))).example, '1.2.3');
		assert.equal(fresh.view.changedPaths().has(lock), false);
		assert.deepEqual(
			s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
			[],
			'nothing was written to the new team'
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the preview's package, text and image reads stay in the team its session opened in", async () => {
	const s = storage();
	for (const [team, name] of [
		[s.alpha, 'Alpha'],
		[s.beta, 'Beta'],
	]) {
		const root = `@/Team/=${team}/.projects/.appdev/same-ui`;
		s.files.set(`${root}/package.json`, JSON.stringify({ name }));
		s.files.set(`${root}/README.md`, `# ${name}`);
		// step: the raw binary read's own path (the test stub has no PROJECT_DIR)
		s.files.set(appPath('same-ui', 'icon.png', { kind: 'team', teamId: team }), name);
	}
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	assert.equal((await readAppPackage('same-ui', old.view)).name, 'Alpha');
	assert.equal(await readAppText('same-ui', 'README.md', old.view), '# Alpha');
	const client = s.client as unknown as Parameters<typeof readAppImageDataUri>[0];
	assert.equal(await readAppImageDataUri(client, 'same-ui', 'icon.png', old.scope), `data:image/png;base64,${btoa('Alpha')}`);
});

test('a listing save whose read ends after the team changes writes the package in the team it started in', async () => {
	for (const autoCommit of [false, true]) {
		const s = storage();
		const pkgPath = (team: string) => `@/Team/=${team}/.projects/.appdev/same-ui/package.json`;
		s.files.set(pkgPath(s.alpha), JSON.stringify({ name: 'alpha-app', appManifest: { id: 'local.same', name: 'Alpha' } }));
		s.files.set(pkgPath(s.beta), JSON.stringify({ name: 'beta-app', appManifest: { id: 'local.same', name: 'Beta' } }));
		const old = await workspace(s.alpha, autoCommit);
		const entered = deferred();
		const release = deferred();
		const read = s.client.fsReadString;
		s.client.fsReadString = async (path: string) => {
			const value = await read(path);
			// step: hold the save's read of the package until the user has switched teams
			if (path === pkgPath(s.alpha)) {
				entered.resolve();
				await release.promise;
			}
			return value;
		};
		const appHost = createWebAppBuilderHost({
			client: s.client as never,
			prefs: undefined as never,
			appId: 'local.same',
			folder: 'same-ui',
			hasReviewLadder: false,
			previewUrl: '',
			session: null,
			onReloadPreview: () => undefined,
			onOpenDebugTab: () => undefined,
		});
		const saving = appHost.saveListing?.({ appId: 'local.same', mode: 'free', name: 'Alpha Listed', description: 'Listed in alpha.', plans: [] });
		await entered.promise;
		const fresh = await workspace(s.beta, autoCommit);
		release.resolve();
		await saving;
		const file = 'apps/same-ui/package.json';
		const mode = autoCommit ? 'auto' : 'manual';
		const saved = JSON.parse(String(await old.view.read(file))) as { name: string; appManifest: { name: string } };
		assert.deepEqual([saved.name, saved.appManifest.name], ['alpha-app', 'Alpha Listed'], `${mode}: the listing landed in the team the save started in`);
		assert.equal(fresh.view.changedPaths().has(file), false, `${mode}: nothing was staged in the new team`);
		assert.equal((JSON.parse(String(await fresh.view.read(file))) as { name: string }).name, 'beta-app', `${mode}: the new team's package is its own`);
		assert.deepEqual(
			s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
			[],
			`${mode}: nothing was written to the new team`
		);
	}
});

/** The parts of a dev session the model test drives: rocket-ui has no Monaco in node, so the test hands it a fake. */
interface DevSessionInternals {
	monaco: unknown;
	models: Map<string, unknown>;
	wireModel(path: string, text: string): unknown;
	adoptExternalChange(path: string): Promise<void>;
	releaseModel(path: string): void;
	emitOne(path: string): Promise<{ js: string } | null>;
}

/**
 * A stand-in for the Monaco API a dev session uses to wire and emit models.
 * Each new model starts at version 1, as Monaco's do, and its emit is its
 * text.
 *
 * @param disposed - Collects the uri of each model disposed.
 * @returns The fake Monaco.
 */
function fakeMonaco(disposed: string[], hold?: { reply: Promise<void>; asked: () => void }): unknown {
	const live = new Map<string, () => string>();
	return {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		editor: {
			getModel: () => null,
			createModel: (text: string, _language: string, uri: { toString(): string }) => {
				let value = text;
				live.set(uri.toString(), () => value);
				return {
					uri,
					getValue: () => value,
					setValue: (next: string) => (value = next),
					getVersionId: () => 1,
					onDidChangeContent: () => ({ dispose: () => undefined }),
					dispose: () => {
						live.delete(uri.toString());
						disposed.push(uri.toString());
					},
				};
			},
		},
		languages: {
			typescript: {
				getTypeScriptWorker: async () => async () => ({
					getEmitOutput: async (uri: string) => {
						// the text at the call, as the worker's own copy is; a hold keeps the reply on its way
						const text = live.get(uri)?.() ?? '';
						hold?.asked();
						await hold?.reply;
						return { outputFiles: [{ name: 'out.js', text }] };
					},
				}),
			},
		},
	};
}

test("a deleted file's model leaves the dev session, and a file the store failed to read keeps its model", async () => {
	// step: Monaco's worker wiring subclasses Worker when its module loads
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	for (const autoCommit of [false, true]) {
		const s = storage();
		const mode = autoCommit ? 'auto' : 'manual';
		const root = `@/Team/=${s.alpha}/.projects/.appdev/gone-ui`;
		s.files.set(`${root}/src/unused.ts`, 'export const unused = 1;');
		s.files.set(`${root}/src/kept.ts`, 'export const kept = 1;');
		// step: the store lists what it holds, so the view's tree has both files
		(s.client as { fsListDir: unknown }).fsListDir = async (dir: string) => {
			const found = new Map<string, 'file' | 'dir'>();
			for (const path of s.files.keys()) {
				if (!path.startsWith(`${dir}/`)) continue;
				const [name, ...below] = path.slice(dir.length + 1).split('/');
				found.set(name, below.length ? 'dir' : 'file');
			}
			return { entries: [...found].map(([name, type]) => ({ name, type })) };
		};
		const ws = await workspace(s.alpha, autoCommit);
		const appId = `local.gone${mode}`;
		const session = new WebDevSession(s.client as never, appId, 'gone-ui', 'Gone');
		const internals = session as unknown as DevSessionInternals;
		const disposed: string[] = [];
		internals.monaco = fakeMonaco(disposed);
		try {
			for (const path of ['src/unused.ts', 'src/kept.ts']) internals.wireModel(path, String(await session.vfs.read(path)));
			// step: the store fails a read of a file it still has
			const read = s.client.fsReadString;
			s.client.fsReadString = async (path: string) => {
				if (path === `${root}/src/kept.ts`) throw new Error('socket closed');
				return read(path);
			};
			session.vfs.invalidate('src/kept.ts');
			await internals.adoptExternalChange('src/kept.ts');
			assert.ok(internals.models.has('src/kept.ts'), `${mode}: a failed read keeps the model`);
			assert.deepEqual(disposed, [], `${mode}: no model was disposed`);
			s.client.fsReadString = read;
			// step: the agent deletes the other file; the session hears of it
			await ws.view.delete('apps/gone-ui/src/unused.ts');
			await internals.adoptExternalChange('src/unused.ts');
			assert.equal(internals.models.has('src/unused.ts'), false, `${mode}: the deleted file's model left the session`);
			assert.deepEqual(disposed, [`file:///${appId}/src/unused.ts`], `${mode}: the deleted file's model was disposed`);
			assert.ok(internals.models.has('src/kept.ts'));
		} finally {
			session.dispose();
		}
	}
});

test("a deleted file's compiled output goes with its model, so a new file at its path is compiled again", async () => {
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	const s = storage();
	await workspace(s.alpha);
	const session = new WebDevSession(s.client as never, 'local.reborn', 'reborn-ui', 'Reborn');
	const internals = session as unknown as DevSessionInternals;
	internals.monaco = fakeMonaco([]);
	try {
		internals.wireModel('src/a.ts', 'export const value = 1;');
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 1;');
		// step: the file is deleted, so its model goes; then a file is created at the same path
		internals.releaseModel('src/a.ts');
		internals.wireModel('src/a.ts', 'export const value = 2;');
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 2;', "the new file's own output, not the deleted file's");
	} finally {
		session.dispose();
	}
});

test("an emit still on its way when its file is deleted and made again does not cache the deleted file's output", async () => {
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	const s = storage();
	await workspace(s.alpha);
	const session = new WebDevSession(s.client as never, 'local.reborn', 'reborn-ui', 'Reborn');
	const internals = session as unknown as DevSessionInternals;
	const reply = deferred();
	const asked = deferred();
	internals.monaco = fakeMonaco([], { reply: reply.promise, asked: asked.resolve });
	try {
		internals.wireModel('src/a.ts', 'export const value = 1;');
		const inFlight = internals.emitOne('src/a.ts');
		await asked.promise;
		// step: while the worker still holds the reply, the file is deleted and made again at the same path and version
		internals.releaseModel('src/a.ts');
		internals.wireModel('src/a.ts', 'export const value = 2;');
		reply.resolve();
		await inFlight;
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 2;', "the new file's own output, not the deleted file's");
	} finally {
		session.dispose();
	}
});

// =============================================================================
// TIMED-OUT CALLS
// =============================================================================

test('a timed-out edit is never overtaken by a later edit of the same file in the real workspace', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const release = deferred();
	let reads = 0;
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		if (path === s.a && ++reads === 2) await release.promise;
		return value;
	};
	const landed: string[] = [];
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (path: string, value: string) => {
		await write(path, value);
		if (path === s.a) landed.push(value);
	};
	const files = new FilesystemTools(ws.view);
	await (
		await files
			.tools()
			.find((t) => t.name === 'read_file')!
			.prepare({ path: 'apps/probe.txt' })
	).run();
	let calls = 0;
	await runLoop({
		request: 'edit',
		history: [],
		prefix: { role: 'review', instructions: [] },
		tools: files.tools(),
		finish: new CheckRecord(async () => null),
		emit: () => undefined,
		timeoutMs: () => 10,
		signal: new AbortController().signal,
		takeQueued: () => [],
		approve: async (_act, run) => run,
		model: async () => {
			if (++calls === 1) {
				return JSON.stringify({
					tool_calls: [
						{ tool: 'edit_file', args: { path: 'apps/probe.txt', oldString: '1', newString: '2' } },
						{ tool: 'edit_file', args: { path: 'apps/probe.txt', oldString: '1', newString: '3' } },
					],
				});
			}
			return boundedStop();
		},
	});
	// step: the first edit is still held; the second was never run
	assert.deepEqual(landed, []);
	release.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(landed, ['const probe = 2;']);
	assert.equal(s.files.get(s.a), 'const probe = 2;');
});

// =============================================================================
// CANVAS SAVES
// =============================================================================

test('a canvas save writes the store once, and a save over a newer pipeline is refused', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const projectVfs = createProjectVfs(s.client as never);
	const content = () => docs.getState().documents['chat.pipe'].content;

	// step: the user edits the canvas and saves; Documents' write of the same content is skipped
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	const loaded = ws.view.version('pipelines/chat.pipe');
	const version = await savePipeline(projectVfs, docs, 'chat.pipe', 'chat.pipe', content(), loaded);
	assert.equal(s.writes.filter((p) => p === pipePath).length, 1, 'one store write per save');
	assert.equal(docs.getState().documents['chat.pipe'].dirty, false);
	assert.equal(version, loaded + 1);

	// step: the agent changes the pipeline; the canvas, still at its old version, is refused
	await ws.view.write('pipelines/chat.pipe', JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	docs.updateContent('chat.pipe', { name: 'Mine again', components: [] });
	await assert.rejects(savePipeline(projectVfs, docs, 'chat.pipe', 'chat.pipe', content(), version), (err: unknown) => err instanceof StaleVersionError && err.lastWriter === 'agent');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Agent', "the agent's change stays");
	assert.equal(docs.getState().documents['chat.pipe'].dirty, true, "the user's canvas is kept for Reload or Overwrite");
});

test('a canvas reload that cannot read the stored pipeline keeps its version, so the next save is refused', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const projectVfs = createProjectVfs(s.client as never);
	const content = () => docs.getState().documents['chat.pipe'].content as { name: string };
	const loaded = ws.view.version('pipelines/chat.pipe');

	// step: the agent writes a pipeline that is not valid JSON; the clean canvas cannot reload it
	await ws.view.write('pipelines/chat.pipe', '{ not json', 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), null);
	assert.equal(content().name, 'Chat', 'the canvas keeps what it showed');

	// step: so a save from the version the canvas really holds is refused, and the agent's write stays
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(savePipeline(projectVfs, docs, 'chat.pipe', 'chat.pipe', content(), loaded), StaleWriteError);
	assert.equal(s.files.get(pipePath), '{ not json');

	// step: a deleted pipeline does not reload either
	await ws.view.delete('pipelines/chat.pipe', 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), null);

	// step: a readable pipeline reloads, at the version it belongs to
	await ws.view.write('pipelines/chat.pipe', JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), ws.view.version('pipelines/chat.pipe'));
	assert.equal(content().name, 'Agent');
	assert.equal(docs.getState().documents['chat.pipe'].dirty, false);
});

test('two editors of one path both guard it: closing one keeps the other, and save and discard act on the dirty ones', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'pipelines/chat.pipe';
	const did: string[] = [];
	const editor = (name: string, dirty: { on: boolean }) => ({
		uri: `${name}.pipe`,
		getContent: () => `${name} canvas`,
		isDirty: () => dirty.on,
		save: async () => {
			did.push(`save ${name}`);
			dirty.on = false;
		},
		discard: async () => {
			did.push(`discard ${name}`);
			dirty.on = false;
		},
	});
	const left = { on: true };
	const right = { on: false };
	const closeLeft = registerEditor(ws.view, path, editor('left', left));
	const closeRight = registerEditor(ws.view, path, editor('right', right));
	assert.equal(ws.view.isDirty(path), true, 'dirty while any editor is');
	assert.equal(await ws.view.read(path), 'left canvas', 'readers get the dirty buffer');

	// step: the newer split closes; the older one, still dirty, still guards the file
	closeRight();
	assert.equal(ws.view.isDirty(path), true);
	assert.equal(await ws.view.read(path), 'left canvas');

	// step: both dirty; save reaches each, discard none once they are clean
	const closeAgain = registerEditor(ws.view, path, editor('right', right));
	right.on = true;
	await editorControl(ws.view, path)?.save();
	assert.deepEqual(did, ['save left', 'save right']);
	await editorControl(ws.view, path)?.discard();
	assert.deepEqual(did, ['save left', 'save right']);

	// step: the last one closes; nothing guards the file, and another workspace never had it
	closeAgain();
	closeLeft();
	assert.equal(ws.view.isDirty(path), false);
	assert.equal(editorControl(ws.view, path), null);
	const other = await workspace(s.beta);
	assert.equal(editorControl(other.view, path), null);
});

// =============================================================================
// EDITOR DOCUMENTS — Ctrl+S, splits, and unsaved text that outlives its tab
// =============================================================================

/** The module that holds a text file's shared document. */
const FILE_DOCUMENT = '../../../../rocket-ui/src/surfaces/workspace/fileDocument';
/** The module that holds a pipeline's shared document. */
const CANVAS_DOCUMENT = '../../../../rocket-ui/src/surfaces/pipelines/canvasDocument';

/** Lets every promise that can move, move. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('Ctrl+S in a canvas saves the canvas only, not a text tab of the same pipeline, and a failed save is not swallowed', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'pipelines/chat.pipe';
	// step: the Ctrl+S path, or round 2's, which saved every dirty editor of the path
	const saveOne = (controls as { saveDocumentEditor?: typeof controls.saveDocumentEditor }).saveDocumentEditor;
	const ctrlS = (uri: string) => (saveOne ? saveOne(ws.view, uri) : editorControl(ws.view, path)?.save());
	const did: string[] = [];
	const editor = (name: string, uri: string, failing: boolean) => {
		const state = { dirty: true };
		return {
			uri,
			getContent: () => name,
			isDirty: () => state.dirty,
			save: async () => {
				did.push(name);
				if (failing) throw new Error(`the ${name} could not be saved`);
				state.dirty = false;
			},
			discard: async () => undefined,
		};
	};
	registerEditor(ws.view, path, editor('text tab', 'file:pipelines/chat.pipe', true));
	registerEditor(ws.view, path, editor('canvas', 'chat.pipe', false));

	// step: both have typing; Ctrl+S in the canvas
	await ctrlS('chat.pipe');
	assert.deepEqual(did, ['canvas'], 'only the canvas saved');
	assert.equal(ws.view.isDirty(path), true, "the text tab's typing stays unsaved");

	// step: Ctrl+S in the text tab, whose save fails: the failure reaches the caller
	await assert.rejects(Promise.resolve(ctrlS('file:pipelines/chat.pipe')), /the text tab could not be saved/);
	assert.equal(saveOne?.(ws.view, 'other.pipe'), null, 'a document no editor holds is left to its caller');
});

test('a text tab closed with unsaved typing keeps its loaded version: the file stays dirty, and its save after reopening is refused when the file moved on', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: the tab loads the file, the user types, then closes the tab (Monaco keeps the text)
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	const loaded = doc.version;
	doc.type('const probe = 1; // mine');
	close();
	assert.equal(ws.view.isDirty(path), true, 'the unsaved text survives the close, so the file is still dirty');
	assert.equal(await ws.view.read(path), 'const probe = 1; // mine', 'readers get the unsaved text');
	assert.ok(editorControl(ws.view, path), "the agent's question can still act on it");

	// step: the file changes meanwhile, by a write that asks nobody
	await ws.view.write(path, 'const probe = 2;', 'agent');

	// step: the tab opens again on the same document: the typing, the old version, the banner
	const again = fileDocument(ws.view, path);
	assert.equal(again, doc);
	const closeAgain = again.open();
	await again.load();
	assert.deepEqual([again.text, again.version, again.dirty, again.stale], ['const probe = 1; // mine', loaded, true, true]);
	await assert.rejects(again.save(), StaleWriteError);
	assert.equal(s.files.get(s.a), 'const probe = 2;', 'the other change stays');

	// step: Reload shows the stored file; once clean and closed, the document goes
	await again.discard();
	assert.deepEqual([again.text, again.dirty, again.stale], ['const probe = 2;', false, false]);
	closeAgain();
	assert.equal(ws.view.isDirty(path), false);
	assert.equal(editorControl(ws.view, path), null);
	assert.notEqual(fileDocument(ws.view, path), doc, 'the next tab loads the stored file afresh');
});

test("the agent asks about a closed tab's unsaved typing; Save mine first saves it with no tab open, and the edit lands on it", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // mine');
	close();

	const asked: string[] = [];
	const files = new FilesystemTools(ws.view, undefined, undefined, {
		choose: async (_title, message) => {
			asked.push(message);
			return 'save';
		},
		editor: (p) => editorControl(ws.view, p),
	});
	const tool = (name: string) => files.tools().find((t) => t.name === name)!;
	await callTool(tool('read_file'), { path });
	await callTool(tool('edit_file'), { path, oldString: 'probe = 1', newString: 'probe = 2' });
	assert.deepEqual(asked, ['The agent wants to change apps/probe.txt, which has unsaved changes.']);
	assert.equal(s.files.get(s.a), 'const probe = 2; // mine', "the user's text was saved first, then edited");
	assert.equal(ws.view.isDirty(path), false);
	assert.equal(editorControl(ws.view, path), null, 'the saved document had no tab, so it went');
});

test('two tabs of one text file share its text, version and save: a save from one leaves the other clean at the new version', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const left = fileDocument(ws.view, path);
	const closeLeft = left.open();
	const right = fileDocument(ws.view, path);
	const closeRight = right.open();
	assert.equal(right, left, 'the splits share one document');
	// step: both editors are bound to one model; setting it echoes back as a change from the other split
	let model = '';
	left.sync = (text) => {
		model = text;
		left.type(text);
	};
	await left.load();
	assert.deepEqual([model, left.dirty], ['const probe = 1;', false], "the document's own change is not typing");

	left.type('const probe = 1; // mine');
	assert.equal(right.dirty, true);
	await left.save();
	assert.deepEqual([right.dirty, right.stale, right.version], [false, false, ws.view.version(path)]);

	// step: nothing is dirty, so another writer goes ahead; the clean tabs follow it
	assert.equal(ws.view.isDirty(path), false);
	await ws.view.write(path, 'const probe = 3;', 'agent');
	await right.load();
	assert.deepEqual([right.text, right.stale, model], ['const probe = 3;', false, 'const probe = 3;']);
	closeLeft();
	assert.ok(editorControl(ws.view, path), 'the other split still holds the file');
	closeRight();
	assert.equal(editorControl(ws.view, path), null);
});

test('a tab closed while its file loads keeps the document until the load lands, so the late load never overwrites typing in the reopened tab', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	type Doc = ReturnType<typeof fileDocument>;
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	// step: one Monaco model per path for the page; the mounted editor echoes a change of it as typing
	let shown: Doc | null = null;
	const bind = (doc: Doc): void => {
		doc.sync ??= (text) => shown?.type(text);
	};
	// step: the first read of the file is held
	const reading = deferred();
	const read = s.client.fsReadString;
	let held = false;
	s.client.fsReadString = async (p: string) => {
		if (p === s.a && !held) {
			held = true;
			await reading.promise;
		}
		return read(p);
	};

	const first = fileDocument(ws.view, path);
	bind(first);
	shown = first;
	const closeFirst = first.open();
	const lateLoad = first.load();
	await flush();
	closeFirst();

	// step: the tab opens again, loads, and the user types
	const again = fileDocument(ws.view, path);
	bind(again);
	shown = again;
	const closeAgain = again.open();
	await again.load();
	again.type('const probe = 1; // mine');

	// step: the first load lands late
	reading.resolve();
	await lateLoad;
	await flush();
	assert.deepEqual([again.text, again.dirty], ['const probe = 1; // mine', true], 'the typing is kept');
	assert.equal(await ws.view.read(path), 'const probe = 1; // mine');
	closeAgain();
});

test("a load of the old team's text tab that lands after a team switch leaves the Monaco model alone, so typing in the new team's tab of the same path stays", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	type Doc = ReturnType<typeof fileDocument>;
	const s = storage();
	const path = 'apps/probe.txt';
	// step: Monaco keeps one model per URI for the page, and the URI names the path, not the team. Each mounted
	// editor reports a change of the model as typing
	const model = { value: '', editors: new Set<Doc>() };
	const setModel = (text: string): void => {
		if (model.value === text) return;
		model.value = text;
		for (const doc of [...model.editors]) doc.type(text);
	};
	// step: a tab as FileProvider mounts it: it joins the document and loads it, then the editor's beforeMount binds the document to the model
	const mount = async (doc: Doc): Promise<() => void> => {
		const close = doc.open();
		await doc.load();
		doc.sync = setModel;
		doc.syncModel();
		model.editors.add(doc);
		return () => {
			model.editors.delete(doc);
			close();
		};
	};

	const old = await workspace(s.alpha);
	const oldDoc = fileDocument(old.view, path);
	const closeOld = await mount(oldDoc);
	assert.equal(model.value, 'const probe = 1;');
	// step: a teammate's change drops the cached copy, and the clean tab's load of it is held
	s.files.set(s.a, 'const probe = 2;');
	old.view.invalidate(path);
	const reading = holdRead(s, s.a);
	const lateLoad = oldDoc.load();
	await reading.held;

	// step: the user switches team, which unmounts the old tab, opens the same path there and types
	closeOld();
	const fresh = await workspace(s.beta);
	const freshDoc = fileDocument(fresh.view, path);
	assert.notEqual(freshDoc, oldDoc);
	const closeFresh = await mount(freshDoc);
	assert.equal(model.value, 'const probe = 900;');
	setModel('const probe = 900; // mine');

	reading.release();
	await lateLoad;
	await flush();
	assert.equal(oldDoc.text, 'const probe = 2;', 'the old document took its load');
	assert.deepEqual([freshDoc.text, freshDoc.dirty, model.value], ['const probe = 900; // mine', true, 'const probe = 900; // mine'], "the new team's typing is kept");
	assert.equal(await fresh.view.read(path), 'const probe = 900; // mine');
	closeFresh();
});

test('an older load that fails after a newer one worked leaves the editor showing the newer text', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	// step: the first read of the file is held, then fails
	const reading = deferred();
	const read = s.client.fsReadString;
	let held = false;
	s.client.fsReadString = async (p: string) => {
		if (p === s.a && !held) {
			held = true;
			await reading.promise;
			throw new Error('the store did not answer');
		}
		return read(p);
	};
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	const oldLoad = doc.load();
	await flush();

	// step: the agent reads the file and changes it; the tab follows the change with a newer load
	await ws.view.read(path);
	await ws.view.write(path, 'const probe = 2;', 'agent');
	await flush();
	assert.equal(doc.text, 'const probe = 2;');

	// step: the old load fails late
	reading.resolve();
	await oldLoad;
	assert.deepEqual([doc.text, doc.error, doc.version], ['const probe = 2;', null, ws.view.version(path)], 'the newer load stands');
	close();
});

test('typing while a text tab saves keeps the tab dirty, at the version of the save', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	const landing = deferred();
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (p: string, value: string) => {
		await landing.promise;
		return write(p, value);
	};
	doc.type('const probe = 1; // saved');
	const saving = doc.save();
	doc.type('const probe = 1; // saved, then more');
	landing.resolve();
	await saving;
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved');
	assert.deepEqual([doc.dirty, doc.version], [true, ws.view.version(path)]);
	await doc.save();
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved, then more');
	close();
});

test("closing the last tab of a dirty canvas drops the pipeline, and its document and the agent's guard go with it", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	const path = 'pipelines/chat.pipe';

	// step: the canvas opens and the user changes a node; the agent now asks before it changes the file
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(async () => undefined);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	assert.equal(ws.view.isDirty(path), true);
	assert.ok(editorControl(ws.view, path));

	// step: the user closes the tab (the shell's dirty-close dialog asked first, and the user chose Don't Save)
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	leave();
	assert.equal(docs.getState().documents['chat.pipe'], undefined, 'Documents drops the pipeline with its last view');
	assert.equal(ws.view.isDirty(path), false, 'nothing guards a pipeline nobody holds');
	assert.equal(editorControl(ws.view, path), null);
	assert.notEqual(canvasDocument(ws.view, docs, path, 'chat.pipe'), doc, 'the next canvas loads the stored pipeline afresh');
});

test("the agent's Save mine first saves an open canvas's unsaved pipeline through the canvas, at its loaded version", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	const path = 'pipelines/chat.pipe';
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	// step: the canvas's save, as PipelineProvider's performSave makes it
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	await editorControl(ws.view, path)?.save();
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Mine');
	assert.equal(s.writes.filter((p) => p === pipePath).length, 1, 'one store write');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, false);
	assert.equal(ws.view.isDirty(path), false);
	assert.equal(doc.version, ws.view.version(path));
	leave();
});

/** A pipeline open on a canvas, in Documents whose dirty-close dialog answers Save, as the shell's close dialog drives it. */
async function canvasForClose(alpha: string, s: ReturnType<typeof storage>, ws: Workspace) {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const pipePath = `@/Team/=${alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents({ vfs: createDocumentsVfs(s.client as never), ui: { confirmDirtyClose: async () => 'save' } });
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	// step: the canvas's save, as PipelineProvider's performSave makes it: it shows its own failure (a dropped save is none) and rethrows
	const failures: unknown[] = [];
	const leave = doc.open(async () => {
		try {
			await doc.save(docs.getState().documents['chat.pipe']?.content);
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) failures.push(err);
			throw err;
		}
	});
	const close = () => docs.requestCloseEditor(Object.keys(docs.getState().editors)[0]);
	return { docs, doc, pipePath, failures, leave, close };
}

test("the close dialog's Save writes the pipeline once, through its canvas, and closes the tab", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	assert.equal(await close(), true);
	leave();
	assert.deepEqual(failures, []);
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Mine');
	assert.equal(s.writes.filter((p) => p === pipePath).length, 1, 'one store write');
	assert.equal(docs.getState().documents['chat.pipe'], undefined);
});

test("the close dialog's Save of a pipeline whose write fails keeps the tab open with the unsaved pipeline", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (path: string, value: string) => {
		if (path === pipePath) throw new Error('the store did not answer');
		return write(path, value);
	};

	assert.equal(await close(), false, 'the close is abandoned');
	assert.equal(failures.length, 1, 'the canvas saved, and showed its failure');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, 'the unsaved pipeline is still there');
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Chat');
	leave();
});

test("the close dialog's Save checks the version the canvas loaded: a pipeline that moved on is not overwritten", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	// step: a write that asks nobody changes the pipeline after the canvas loaded it
	const loaded = doc.version;
	await ws.view.write('pipelines/chat.pipe', JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	assert.notEqual(ws.view.version('pipelines/chat.pipe'), loaded);

	assert.equal(await close(), false, 'the close is abandoned');
	assert.ok(failures[0] instanceof StaleWriteError, 'the canvas refused the save as stale (its dialog offers Reload or Overwrite)');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Agent', 'the other change stays');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	leave();
});

test("in manual mode, the close dialog's Save closes a canvas only once a save of its pipeline is kept: it waits for a save the staging store is still keeping, and a failed one keeps the tab open", { timeout: 10_000 }, async () => {
	for (const when of ['kept late', 'fails late', 'failed'] as const) {
		const s = storage();
		const ws = await manualWorkspace(s.alpha);
		const { docs, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
		docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
		// step: a staged save is in the view at once, but only the staging store's manifest keeps it over a reload
		const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
		const [entered, gate] = [deferred(), deferred()];
		if (when === 'failed') gate.resolve();
		const write = s.client.fsWriteJson;
		s.client.fsWriteJson = async (p: string, value: unknown) => {
			if (p !== manifest) return write(p, value);
			entered.resolve();
			await gate.promise;
			if (when === 'kept late') return write(p, value);
			throw new Error('the store did not answer');
		};
		const saving = outcome(controls.saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined);
		await entered.promise;
		if (when === 'failed') assert.ok((await saving) instanceof Error, 'Ctrl+S failed');

		// step: the user closes the tab and answers Save
		let settled = false;
		const closing = close().then((closed) => {
			settled = true;
			return closed;
		});
		await flush();
		if (when !== 'failed') assert.equal(settled, false, `${when}: the close waits for the save on its way`);
		gate.resolve();
		const closed = await closing;
		await saving;
		if (when === 'kept late') {
			assert.equal(closed, true, `${when}: the save was kept, so the tab closes`);
			assert.equal(docs.getState().documents['chat.pipe'], undefined);
			assert.ok(manifestPaths(s, s.alpha).includes('pipelines/chat.pipe'), `${when}: a reload brings the pipeline back`);
			assert.deepEqual(failures, []);
		} else {
			assert.equal(closed, false, `${when}: no save was kept, so the close is abandoned`);
			assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, `${when}: the unsaved pipeline is still there`);
			assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine');
			assert.ok(failures.length > 0, `${when}: the canvas showed the failure`);
		}
		leave();
	}
});

test("in manual mode, the close dialog's Save does not trust a kept save of the same pipeline that a discard undid", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const { docs, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
	const mine = { name: 'Mine', components: [] };
	// step: the canvas saves Mine, and the staging store keeps it
	docs.updateContent('chat.pipe', mine);
	await controls.saveDocumentEditor(ws.view, 'chat.pipe');
	assert.ok(manifestPaths(s, s.alpha).includes('pipelines/chat.pipe'));
	// step: the user discards the staged change, then the same text lands in the view again (a text tab's save) but the staging store fails to keep it
	await ws.view.discard('pipelines/chat.pipe');
	assert.ok(!manifestPaths(s, s.alpha).includes('pipelines/chat.pipe'), 'the discard dropped it');
	const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
	const write = s.client.fsWriteJson;
	s.client.fsWriteJson = async (p: string, value: unknown) => {
		if (p === manifest) throw new Error('the store did not answer');
		return write(p, value);
	};
	await ws.view.write('pipelines/chat.pipe', JSON.stringify(mine, null, 2), 'editor').catch(() => undefined);
	docs.updateContent('chat.pipe', { ...mine });

	// step: the user closes the canvas and answers Save
	const closed = await close();
	assert.ok(!closed || manifestPaths(s, s.alpha).includes('pipelines/chat.pipe'), 'a closed tab means a reload brings the pipeline back');
	assert.equal(closed, false, 'nothing kept the pipeline, so the close is abandoned');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	assert.ok(failures.length > 0, 'the canvas saved, and showed its failure');
	leave();
});

test('in manual mode, a kept save counts at its own version, not one a discard and a write queued behind it gave the path', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const { docs, leave, close } = await canvasForClose(s.alpha, s, ws);
	const mine = { name: 'Mine', components: [] };
	const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
	// step: hold the next manifest write that keeps the pipeline; fail it if asked
	type Hold = { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred>; fail: boolean };
	let hold: Hold | null = null;
	const write = s.client.fsWriteJson;
	s.client.fsWriteJson = async (p: string, value: unknown) => {
		if (p === manifest && hold && JSON.stringify(value).includes('pipelines/chat.pipe')) {
			const held = hold;
			hold = null;
			held.entered.resolve();
			await held.gate.promise;
			if (held.fail) throw new Error('the store did not answer');
		}
		return write(p, value);
	};
	// step: the canvas saves Mine, and the staging store holds its manifest write
	const first: Hold = { entered: deferred(), gate: deferred(), fail: false };
	hold = first;
	docs.updateContent('chat.pipe', mine);
	const saving = outcome(controls.saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined);
	await first.entered.promise;
	// step: the user types, and a discard and a write of the same text queue behind the save
	docs.updateContent('chat.pipe', { name: 'Typed', components: [] });
	const discarding = ws.view.discard('pipelines/chat.pipe');
	const rewriting = ws.view.write('pipelines/chat.pipe', JSON.stringify(mine, null, 2), 'editor').catch(() => undefined);
	const second: Hold = { entered: deferred(), gate: deferred(), fail: true };
	hold = second;
	first.gate.resolve();
	await saving;
	await discarding;
	await second.entered.promise;
	// step: while the staging store holds the rewrite, the user puts Mine back on the canvas and closes it with Save
	docs.updateContent('chat.pipe', { ...mine });
	const closing = close();
	await flush();
	second.gate.resolve();
	await rewriting;
	const closed = await closing;
	assert.ok(!closed || manifestPaths(s, s.alpha).includes('pipelines/chat.pipe'), 'a closed tab means a reload brings the pipeline back');
	assert.equal(closed, false, 'nothing kept the pipeline, so the close is abandoned');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	leave();
});

test('in manual mode, a canvas save that a discard and a write queued behind it overtake still finishes, and the tab stays dirty', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const { docs, leave } = await canvasForClose(s.alpha, s, ws);
	const mine = { name: 'Mine', components: [] };
	const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
	// step: hold the manifest write that keeps the canvas's save
	const [entered, gate] = [deferred(), deferred()];
	let held = false;
	const write = s.client.fsWriteJson;
	s.client.fsWriteJson = async (p: string, value: unknown) => {
		if (p === manifest && !held && JSON.stringify(value).includes('pipelines/chat.pipe')) {
			held = true;
			entered.resolve();
			await gate.promise;
		}
		return write(p, value);
	};
	docs.updateContent('chat.pipe', mine);
	const saving = outcome(controls.saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined);
	await entered.promise;
	// step: a discard and a write of the same text queue behind the save, with no typing
	const discarding = ws.view.discard('pipelines/chat.pipe');
	const rewriting = ws.view.write('pipelines/chat.pipe', JSON.stringify(mine, null, 2), 'editor');
	gate.resolve();
	await discarding;
	await rewriting;
	const within = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 2_000))]);
	assert.equal(await within(saving), 'settled', 'the save does not wait on itself');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, 'the path moved on after the save, so the tab is not marked clean');
	assert.equal(await within(outcome(controls.saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined)), 'settled', 'the next save is not blocked');
	leave();
});

test('typing on the canvas while it saves keeps the tab dirty, at the version of the save', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const landing = deferred();
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (path: string, value: string) => {
		if (path === pipePath) await landing.promise;
		return write(path, value);
	};
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const saving = editorControl(ws.view, 'pipelines/chat.pipe')?.save();
	// step: the user types while the write is on its way
	docs.updateContent('chat.pipe', { name: 'Saved, then more', components: [] });
	landing.resolve();
	await saving;

	assert.deepEqual(failures, [], 'the save worked');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Saved');
	assert.equal(s.writes.filter((p) => p === pipePath).length, 1, 'the typing was not written behind the save');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, 'the typing is still unsaved');
	assert.equal(doc.version, ws.view.version('pipelines/chat.pipe'), 'the canvas is at the version of its save');

	// step: the next save writes the typing
	await editorControl(ws.view, 'pipelines/chat.pipe')?.save();
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Saved, then more');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, false);
	leave();
});

test('typing on a clean canvas while it follows an outside change is kept, and the next save asks', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const loaded = doc.version;
	// step: hold Documents' read of the pipeline while the clean canvas reloads it
	const reading = deferred();
	const adapter = (docs as unknown as { _vfs: { read: (uri: string) => Promise<unknown> } })._vfs;
	const read = adapter.read.bind(adapter);
	adapter.read = async (uri) => {
		await reading.promise;
		return read(uri);
	};
	await ws.view.write('pipelines/chat.pipe', JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await flush();
	// step: the user types before the reload's read comes back
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	reading.resolve();
	await flush();

	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine', 'the typing is kept');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	assert.equal(doc.version, loaded, 'the reload did not count: the canvas still holds what it loaded');
	await assert.rejects(editorControl(ws.view, 'pipelines/chat.pipe')!.save(), StaleWriteError);
	assert.ok(failures[0] instanceof StaleWriteError, 'the save asks Reload or Overwrite');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Agent', "the agent's change stays");
	leave();
});

test("renaming a file with unsaved typing in a text tab is refused, so its tab and the agent's guard stay on the file", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // mine');

	// step: the Explorer renames the file
	await assert.rejects(ws.view.rename(path, 'apps/renamed.txt', 'workspace'), /Save or discard the unsaved changes in apps\/probe\.txt first/);
	assert.equal(ws.view.isDirty(path), true, 'the unsaved typing still guards the file');
	assert.equal(ws.view.isDirty('apps/renamed.txt'), false, 'the overlay did not move');
	assert.ok(editorControl(ws.view, path), "the agent's Save mine first and Discard mine still find the tab");
	assert.equal(s.files.get(s.a), 'const probe = 1;');
	assert.equal(s.files.has(`@/Team/=${s.alpha}/.projects/.appdev/renamed.txt`), false);

	// step: saved, the rename goes ahead
	await doc.save();
	await ws.view.rename(path, 'apps/renamed.txt', 'workspace');
	assert.equal(s.files.get(`@/Team/=${s.alpha}/.projects/.appdev/renamed.txt`), 'const probe = 1; // mine');
	close();
});

test('renaming a pipeline with unsaved canvas changes is refused before its tab is closed, so the changes stay', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, leave } = await canvasForClose(s.alpha, s, ws);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: what the Explorer's and the sidebar's rename do: rename, then re-home the open tabs
	const rename = async (): Promise<void> => {
		await ws.view.rename('pipelines/chat.pipe', 'pipelines/renamed.pipe', 'workspace');
		for (const id of Object.keys(docs.getState().editors)) docs.closeEditor(id);
		await docs.openDocument('renamed.pipe');
	};
	await assert.rejects(rename(), /Save or discard the unsaved changes in pipelines\/chat\.pipe first/);
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, 'the unsaved pipeline is still open');
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Chat');
	assert.equal(s.files.has(`@/Team/=${s.alpha}/.projects/renamed.pipe`), false);
	leave();
});

test('a canvas that opens on a pipeline Documents restored with unsaved changes asks before its first save', async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	// step: the page reloads with a dirty pipeline in its saved state; the stored file changed while it was closed
	s.files.set(pipePath, JSON.stringify({ name: 'Changed while closed', components: [] }, null, 2));
	const ws = await workspace(s.alpha);
	const restored = {
		documents: { 'chat.pipe': { uri: 'chat.pipe', content: { name: 'Mine', components: [] }, dirty: true, version: 4, editorCount: 1, isNew: false } },
		editors: { 'editor-1': { id: 'editor-1', documentUri: 'chat.pipe', scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1, label: 'chat.pipe' } },
		groups: { 'group-1': { id: 'group-1', editorIds: ['editor-1'], activeEditorIndex: 0 } },
		rootNode: { type: 'leaf', id: 'group-1', groupId: 'group-1' },
		activeGroupId: 'group-1',
	};
	const docs = new Documents({ vfs: createDocumentsVfs(s.client as never), workspace: { appState: { documents: restored }, updateAppState: () => {} } });
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);

	// step: its canvas mounts at boot; something in the page has read the stored pipeline (the agent's read_file, say), so the server's freshness check passes
	await ws.view.read('pipelines/chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	await assert.rejects(editorControl(ws.view, 'pipelines/chat.pipe')!.save(), StaleWriteError, 'the first save asks Reload or Overwrite');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Changed while closed');

	// step: Overwrite saves the restored pipeline on purpose
	await doc.save(docs.getState().documents['chat.pipe']?.content, { overwrite: true });
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Mine');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, false);
	leave();
	docs.destroy();
});

test('a clean canvas whose reload failed tries again on the next change in the workspace', async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	const path = 'pipelines/chat.pipe';
	await docs.openDocument('chat.pipe');
	// step: Documents' first reload reads nothing, as when the read times out or the store does not answer
	let failures = 1;
	const flaky: CanvasDocs = {
		getState: () => docs.getState(),
		subscribe: (listener) => docs.subscribe(listener),
		saveDocument: (uri) => docs.saveDocument(uri),
		revertDocument: async (uri) => {
			if (failures-- > 0) return;
			return docs.revertDocument(uri);
		},
	};
	const doc = canvasDocument(ws.view, flaky, path, 'chat.pipe');
	const leave = doc.open(async () => undefined);
	const loaded = doc.version;
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string };

	// step: the agent changes the pipeline; the clean canvas follows, but its reload fails
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await flush();
	assert.deepEqual([doc.version, content().name], [loaded, 'Chat'], 'a failed reload keeps the old version');

	// step: any later change in the workspace makes it try again, at the same version
	await ws.view.write('apps/other.txt', 'other', 'agent');
	await flush();
	assert.deepEqual([doc.version, content().name], [ws.view.version(path), 'Agent']);
	leave();
});

test("a canvas that mounts after a change overtook its pipeline's first read names the read's version, so its save asks before it overwrites the change", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	const path = 'pipelines/chat.pipe';

	// step: the tab's first read of the pipeline is slow, and the agent stages its change before the read comes back
	const read = holdRead(s, pipePath);
	const opening = docs.openDocument('chat.pipe');
	await read.held;
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	read.release();
	await opening;
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Chat', 'the tab shows what the read found');

	// step: the canvas mounts on it, and the user edits at once and saves
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	assert.notEqual(doc.version, ws.view.version(path), 'the canvas names the version its content was read at, not the newer one');
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(editorControl(ws.view, path)!.save(), StaleWriteError, 'the save asks Reload or Overwrite');
	await flush();
	assert.equal(JSON.parse(String((await ws.view.readVersioned(path, { stored: true })).content)).name, 'Agent', "the agent's change stays");
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine', 'so does the typing');
	leave();
});

test('typing on a canvas while it reloads keeps the pipeline dirty, so a rename is refused and the typing stays', async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));

	// step: the user discards the agent's change, so the clean canvas reloads the stored pipeline; its read is slow
	const read = holdRead(s, pipePath);
	await ws.view.discardPath(path);
	await read.held;
	const reloading = doc.reload;
	// step: the user types before the read comes back, then renames the pipeline in the sidebar
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	assert.equal(ws.view.isDirty(path), true, 'the typing guards the pipeline during the reload');
	await assert.rejects(ws.view.rename(path, 'pipelines/renamed.pipe', 'workspace'), /Save or discard the unsaved changes in pipelines\/chat\.pipe first/);
	read.release();
	assert.equal(await reloading, false, 'the reload is not applied over the typing');

	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Mine');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	assert.equal(s.files.has(`@/Team/=${s.alpha}/.projects/renamed.pipe`), false);
	leave();
});

test("a canvas reloading a pipeline leaves a text tab's unsaved typing on it guarding the file, and reads the stored pipeline, not the typing", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	// step: the same pipeline is open in a text tab too, with unsaved typing
	const text = fileDocument(ws.view, path);
	const closeText = text.open();
	await text.load();
	const typed = JSON.stringify({ name: 'Typed in the text tab', components: [] });
	text.type(typed);

	// step: the user discards the agent's change; the clean canvas reloads, and its read is slow
	const read = holdRead(s, pipePath);
	await ws.view.discardPath(path);
	await read.held;
	const reloading = doc.reload;
	assert.equal(ws.view.isDirty(path), true, "the text tab's typing still guards the pipeline");
	assert.equal(await ws.view.read(path), typed, 'other readers still get the typing');
	await assert.rejects(ws.view.rename(path, 'pipelines/renamed.pipe', 'workspace'), /Save or discard the unsaved changes in pipelines\/chat\.pipe first/);
	read.release();

	assert.equal(await reloading, true);
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Chat', 'the canvas shows the stored pipeline');
	assert.equal(text.text, typed, 'the text tab keeps its typing');
	closeText();
	leave();
});

test('typing in a text tab while its discard reloads the file keeps the file dirty, so a rename is refused and the typing stays', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // to discard');

	// step: Discard mine reads the stored file again; hold that read once it has the content
	const [reading, landing] = [deferred(), deferred()];
	const readVersioned = ws.view.readVersioned.bind(ws.view);
	ws.view.readVersioned = async (p, opts) => {
		ws.view.readVersioned = readVersioned;
		const out = await readVersioned(p, opts);
		reading.resolve();
		await landing.promise;
		return out;
	};
	const discarding = doc.discard();
	await reading.promise;
	// step: the user types before the read comes back, then renames the file in the Explorer
	doc.type('const probe = 1; // typed during the reload');
	assert.equal(ws.view.isDirty(path), true, 'the typing guards the file during the reload');
	await assert.rejects(ws.view.rename(path, 'apps/renamed.txt', 'workspace'), /Save or discard the unsaved changes in apps\/probe\.txt first/);
	landing.resolve();
	await discarding;

	assert.equal(doc.text, 'const probe = 1; // typed during the reload');
	assert.equal(doc.dirty, true);
	assert.equal(s.files.get(s.a), 'const probe = 1;');
	close();
});

// =============================================================================
// SLOW READS AND SECOND EDITORS — what an editor loads, and under which version
// =============================================================================

test("a pipeline read that Commit all overtook is read again, so the canvas follows the agent's change and a save on top keeps it", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	const path = 'pipelines/chat.pipe';

	// step: the tab's first read of the pipeline is slow; meanwhile the agent reads and changes it, and Commit all stores the change
	const read = holdRead(s, pipePath);
	const opening = docs.openDocument('chat.pipe');
	await read.held;
	await ws.view.readVersioned(path);
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await ws.policy.commitAll();
	read.release();
	await opening;

	// step: the canvas mounts and follows the stored pipeline
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	await doc.reload;
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string; components: unknown[] };
	assert.deepEqual([content().name, doc.version], ['Agent', ws.view.version(path)], "the canvas shows the agent's change, at its version");

	// step: the user edits on top and saves, and Commit all stores both
	docs.updateContent('chat.pipe', { ...content(), note: 'mine' });
	await doc.save(docs.getState().documents['chat.pipe']?.content);
	await ws.policy.commitAll();
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'Agent', components: [], note: 'mine' });
	leave();
});

test("a text tab's first read that Commit all overtook is read again, so the tab never shows the old file at the new version", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();

	// step: the tab's first read is slow; meanwhile the agent reads and changes the file, and Commit all stores the change
	const read = holdRead(s, s.a);
	const loading = doc.load();
	await read.held;
	await ws.view.readVersioned(path);
	await ws.view.write(path, 'const probe = 2;', 'agent');
	await ws.policy.commitAll();
	read.release();
	await loading;

	// step: a later change elsewhere makes the clean tab read the file again
	await ws.view.write('apps/other.txt', 'other', 'agent');
	await flush();
	assert.deepEqual([doc.text, doc.version], ['const probe = 2;', ws.view.version(path)]);
	doc.type('const probe = 2; // mine');
	await doc.save();
	await ws.policy.commitAll();
	assert.equal(s.files.get(s.a), 'const probe = 2; // mine');
	close();
});

test("the agent's read that Commit all overtook is read again, so its next edit starts from the stored file", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';
	const files = new FilesystemTools(ws.view);
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);

	// step: the agent's read is slow; meanwhile the user saves a change, and Commit all stores it
	const read = holdRead(s, s.a);
	const reading = tool('read_file', { path });
	await read.held;
	await ws.view.readVersioned(path);
	await ws.view.write(path, 'const probe = 2; // mine', 'editor');
	await ws.policy.commitAll();
	read.release();
	await reading;

	assert.equal(await tool('read_file', { path }), 'const probe = 2; // mine', 'a second read gets the stored file');
	await assert.rejects(tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 3;' }), /oldString not found/);
	await ws.policy.commitAll();
	assert.equal(s.files.get(s.a), 'const probe = 2; // mine');
});

test('a batch read that Commit all overtook drops what it cached, so a text tab then loads the stored file', async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: a search reads the file in a batch, which is slow; meanwhile the agent changes it and Commit all stores the change
	const [held, landing] = [deferred(), deferred()];
	const readMany = s.client.fsReadMany;
	s.client.fsReadMany = async (paths: string[]) => {
		s.client.fsReadMany = readMany;
		const found = await readMany(paths);
		held.resolve();
		await landing.promise;
		return found;
	};
	const batch = ws.view.readMany([path]);
	await held.promise;
	await ws.view.write(path, 'const probe = 2;', 'agent');
	await ws.policy.commitAll();
	landing.resolve();
	assert.deepEqual(await batch, { [path]: 'const probe = 2;' }, 'the overtaken path is read again');

	// step: a text tab opens on the file
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	assert.deepEqual([doc.text, doc.version], ['const probe = 2;', ws.view.version(path)]);
	close();
});

test("a canvas opened over a text tab's unsaved typing shows the stored pipeline, so after Discard mine the typing does not come back through the canvas", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	ws.view.upsert(path, 'file');

	// step: the pipeline is open as text with unsaved typing, then the user opens its canvas
	const text = fileDocument(ws.view, path);
	const closeText = text.open();
	await text.load();
	text.type(JSON.stringify({ name: 'Typed in the text tab', components: [] }));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	await doc.reload;
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string; components: unknown[] };
	assert.equal(content().name, 'Chat', 'the canvas shows the stored pipeline, not the typing');

	// step: the agent changes the pipeline, and the user answers Discard mine
	const files = new FilesystemTools(ws.view, undefined, undefined, { choose: async () => 'discard', editor: (p) => editorControl(ws.view, p) });
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });
	await assert.rejects(tool('write_file', { path, content: JSON.stringify({ name: 'Agent', components: [] }) }), /changed since you read it/);
	await flush();
	assert.equal(JSON.parse(text.text as string).name, 'Chat', 'the text tab shows the stored pipeline again');

	// step: the user edits the canvas and saves, and Commit all stores it
	docs.updateContent('chat.pipe', { ...content(), note: 'mine' });
	await doc.save(docs.getState().documents['chat.pipe']?.content);
	await ws.policy.commitAll();
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'Chat', components: [], note: 'mine' }, 'the discarded typing is not stored');
	closeText();
	leave();
});

test("a text tab opened over a canvas's unsaved pipeline shows the stored file, so after the canvas discards it the pipeline does not come back through the tab", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';

	// step: the canvas has unsaved changes, then the user opens the pipeline as text
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	docs.updateContent('chat.pipe', { name: 'Unsaved on the canvas', components: [] });
	const text = fileDocument(ws.view, path);
	const closeText = text.open();
	await text.load();
	assert.deepEqual([JSON.parse(text.text as string).name, text.dirty], ['Chat', false], 'the text tab shows the stored pipeline, not the canvas changes');

	// step: the canvas drops its changes (Discard mine), then the user edits the text tab and saves
	assert.equal(await doc.reloadStored(), true);
	await flush();
	text.type(JSON.stringify({ name: 'Chat', components: [], note: 'mine' }, null, 2));
	await text.save();
	await ws.policy.commitAll();
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'Chat', components: [], note: 'mine' }, 'the discarded canvas changes are not stored');
	closeText();
	leave();
});

test("a text tab's Overwrite saves over the change it was shown, and asks again about one that lands while it reads the stored file", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // mine');

	// step: the agent changes the file and Commit all stores it, so the tab's save asks Reload or Overwrite
	await ws.view.write(path, 'const probe = 2;', 'agent');
	await ws.policy.commitAll();
	await assert.rejects(doc.save(), StaleWriteError);

	// step: the user picks Overwrite; its read of the stored file is slow, and the agent changes the file again meanwhile
	const read = holdRead(s, s.a);
	const overwriting = doc.save(true);
	await read.held;
	await ws.view.write(path, 'const probe = 3;', 'agent');
	read.release();
	await assert.rejects(overwriting, StaleWriteError, 'the save asks again');
	assert.equal(String((await ws.view.readVersioned(path, { stored: true })).content), 'const probe = 3;', "the agent's later change stays");
	assert.deepEqual([doc.text, doc.dirty], ['const probe = 1; // mine', true], 'so does the typing');

	// step: Overwrite again, with nothing in the way, saves over the change the user was shown
	await doc.save(true);
	await ws.policy.commitAll();
	assert.equal(s.files.get(s.a), 'const probe = 1; // mine');
	close();
});

test("a canvas's Overwrite asks again about a change that lands while it reads the stored pipeline", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: the agent changes the pipeline and Commit all stores it, so the canvas's save asks Reload or Overwrite
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await ws.policy.commitAll();
	const mine = () => docs.getState().documents['chat.pipe']?.content;
	await assert.rejects(doc.save(mine()), StaleWriteError);

	// step: the user picks Overwrite; its read of the stored pipeline is slow, and the agent changes it again meanwhile
	const read = holdRead(s, pipePath);
	const overwriting = doc.save(mine(), { overwrite: true });
	await read.held;
	await ws.view.write(path, JSON.stringify({ name: 'Agent again', components: [] }, null, 2), 'agent');
	read.release();
	await assert.rejects(overwriting, StaleWriteError, 'the save asks again');
	assert.equal(JSON.parse(String((await ws.view.readVersioned(path, { stored: true })).content)).name, 'Agent again', "the agent's later change stays");
	assert.equal((mine() as { name: string }).name, 'Mine', 'so does the canvas change');
	leave();
});

// =============================================================================
// THE SERVER'S COPY — the dev preview's reads, Reload, and a teammate's change
// =============================================================================

/**
 * What the dev preview does with the app's files (devSession.ts): it opens
 * with one batch read through the view and primes each file it got, and on
 * each change notice it reads the file again and primes it.
 *
 * @param view - The workspace view.
 * @param paths - The app's files.
 */
async function previewOpens(view: Workspace['view'], paths: string[]): Promise<void> {
	for (const [path, content] of Object.entries(await view.readMany(paths))) view.prime(path, String(content));
}

test("a preview that opens over a text tab's unsaved typing leaves the stored file in the cache, so after Discard mine the agent's edit keeps the saved lines", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/demo/src/App.tsx';
	const store = `@/Team/=${s.alpha}/.projects/.appdev/demo/src/App.tsx`;
	const stored = 'export const heading = "original";\nexport const saved = "keep";\n';
	s.files.set(store, stored);

	// step: the user deletes a saved line in a text tab and does not save, then opens the app's preview
	const text = fileDocument(ws.view, path);
	const close = text.open();
	await text.load();
	text.type('export const heading = "original";\n');
	await previewOpens(ws.view, [path]);
	ws.view.prime(path, String(await ws.view.read(path)));
	assert.equal(ws.view.cachedContent(path), stored, 'the cache holds the stored file, not the typing');

	// step: the agent edits the heading, and the user answers Discard mine
	const files = new FilesystemTools(ws.view, undefined, undefined, { choose: async () => 'discard', editor: (p) => editorControl(ws.view, p) });
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });
	await tool('edit_file', { path, oldString: '"original"', newString: '"agent"' });
	await flush();
	await ws.policy.commitAll();
	const edited = 'export const heading = "agent";\nexport const saved = "keep";\n';
	assert.equal(s.files.get(store), edited, 'the saved line the user chose to keep is stored');
	assert.deepEqual([text.text, text.dirty], [edited, false]);
	close();
});

test("a preview's read of a staged change that it primes after Discard all leaves the stored file in the cache", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: the agent's change is staged; the preview hears of it and reads it, and Discard all lands before the preview primes it
	await ws.view.write(path, 'const probe = 2; // agent', 'agent');
	const seen = String(await ws.view.read(path));
	await ws.policy.discardAll();
	ws.view.prime(path, seen);
	assert.equal(ws.view.cachedContent(path), undefined, 'the discarded change is not cached');
	assert.equal(String((await ws.view.readVersioned(path, { stored: true })).content), 'const probe = 1;');
	assert.equal(await ws.view.read(path), 'const probe = 1;');
});

test("a text tab's Reload after a save refused for a teammate's change shows the server's copy, and the next save keeps the change", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: a teammate changes the file; the user types and saves, and the save is refused
	s.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	assert.equal(doc.stale, true);

	// step: Reload shows the server's copy, clean; a save on top of it lands and keeps the teammate's change
	await doc.discard();
	assert.deepEqual([doc.text, doc.dirty, doc.stale], ['const probe = 2; // teammate', false, false]);
	doc.type('const probe = 2; // teammate, then mine');
	await doc.save();
	assert.equal(s.files.get(s.a), 'const probe = 2; // teammate, then mine');
	close();
});

test("a canvas's Reload after a save refused for a teammate's change shows the server's pipeline, and the next save keeps the change", async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string };
	const leave = doc.open(() => doc.save(content()));

	// step: a teammate changes the pipeline; the user edits the canvas and saves, and the save is refused
	s.files.set(pipePath, JSON.stringify({ name: 'Teammate', components: [] }, null, 2));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(doc.save(content()), StaleWriteError);

	// step: Reload shows the server's pipeline, clean; a save on top of it lands and keeps the teammate's change
	assert.equal(await doc.reloadStored(), true);
	assert.deepEqual([content().name, docs.getState().documents['chat.pipe']?.dirty], ['Teammate', false]);
	docs.updateContent('chat.pipe', { name: 'Teammate', components: [], note: 'mine' });
	await doc.save(content());
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'Teammate', components: [], note: 'mine' });
	leave();
});

test("the agent's write refused for a teammate's change drops the cached copy, so its next read gets the server's copy and its edit keeps the change", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const files = new FilesystemTools(ws.view);
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);

	// step: the agent reads the file; a teammate changes it; the agent's edit is refused
	await tool('read_file', { path });
	s.files.set(s.a, 'const probe = 1; // teammate');
	await assert.rejects(tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' }), /^RefusedError: edit_file refused: apps\/probe\.txt changed on the server since you read it \(another tab or a teammate\)\. Read it again, then redo the change from the current content\.$/);
	assert.equal(s.files.get(s.a), 'const probe = 1; // teammate');

	// step: the agent reads it again and gets the server's copy; its edit then lands on it
	assert.equal(await tool('read_file', { path }), 'const probe = 1; // teammate');
	await tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' });
	assert.equal(s.files.get(s.a), 'const probe = 2; // teammate');
});

test("in manual mode, Commit all meets a conflict over a teammate's change that a tab's save or the agent's edit never saw, and stores neither over it", async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: a teammate changes the file; the user types and saves in the tab, and runs Commit all
	s.files.set(s.a, 'const probe = 1; // teammate');
	doc.type('const probe = 1; // mine');
	await doc.save();
	assert.deepEqual(await ws.policy.commitAll(), { committed: 0, conflicts: [{ path, reason: 'changed' }] });
	assert.equal(s.files.get(s.a), 'const probe = 1; // teammate');
	assert.equal(await ws.view.read(path), 'const probe = 1; // mine', 'the save stays staged');

	// step: the user discards the file, and the tab shows the teammate's change
	await ws.view.discard(path);
	await flush();
	assert.deepEqual([doc.text, doc.dirty], ['const probe = 1; // teammate', false]);

	// step: the agent reads the file; the teammate changes it again; the agent edits it, and Commit all runs
	const files = new FilesystemTools(ws.view);
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });
	s.files.set(s.a, 'const probe = 1; // teammate again');
	await tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' });
	assert.deepEqual(await ws.policy.commitAll(), { committed: 0, conflicts: [{ path, reason: 'changed' }] });
	assert.equal(s.files.get(s.a), 'const probe = 1; // teammate again');
	close();
});

test('a batch read on its way when the cached copy is dropped does not put the older copy back', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: a batch read of the file (the preview opening) is slow, and holds the copy it read
	const [held, landing] = [deferred(), deferred()];
	const readMany = s.client.fsReadMany;
	s.client.fsReadMany = async (paths: string[]) => {
		s.client.fsReadMany = readMany;
		const found = await readMany(paths);
		held.resolve();
		await landing.promise;
		return found;
	};
	const batch = ws.view.readMany([path]);
	await held.promise;

	// step: a teammate changes the file; a Reload drops the cached copy and reads the server's; then the batch lands
	s.files.set(s.a, 'const probe = 2; // teammate');
	ws.view.invalidate(path);
	assert.equal(String((await ws.view.readVersioned(path, { stored: true })).content), 'const probe = 2; // teammate');
	landing.resolve();
	assert.deepEqual(await batch, { [path]: 'const probe = 2; // teammate' }, 'the batch reads the file again');
	assert.equal(ws.view.cachedContent(path), 'const probe = 2; // teammate', 'the cache keeps the newer copy');
	await ws.view.write(path, 'const probe = 3;', 'editor');
	assert.equal(s.files.get(s.a), 'const probe = 3;', 'so a save checked against it lands');
});

test("typing during a text tab's Reload starts from the stored text it had, and a save of it is refused, so the teammate's change stays", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	s.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);

	// step: the user clicks Reload; its read of the server's copy is slow, and the user types and saves meanwhile
	const read = holdRead(s, s.a);
	const reloading = doc.discard();
	await read.held;
	assert.equal(doc.text, 'const probe = 1;', 'the tab shows the stored text it had at once, not the dropped typing');
	doc.type('const probe = 1; // typed during the reload');
	await assert.rejects(doc.save(), StaleWriteError);
	read.release();
	await reloading;
	assert.deepEqual([doc.text, doc.dirty, doc.stale], ['const probe = 1; // typed during the reload', true, true], 'the typing stays, and the tab asks Reload or Overwrite');
	assert.equal(s.files.get(s.a), 'const probe = 2; // teammate');

	// step: Reload again, with nothing typed meanwhile, shows the change
	await doc.discard();
	assert.deepEqual([doc.text, doc.dirty, doc.stale], ['const probe = 2; // teammate', false, false]);
	close();
});

test("editing a canvas during its Reload keeps the edit, and a save of it is refused, so the teammate's change stays", { timeout: 10_000 }, async () => {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string };
	const leave = doc.open(() => doc.save(content()));
	s.files.set(pipePath, JSON.stringify({ name: 'Teammate', components: [] }, null, 2));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(doc.save(content()), StaleWriteError);

	// step: the user clicks Reload; its read of the server's pipeline is slow, and the user edits the canvas meanwhile
	const read = holdRead(s, pipePath);
	const reloading = doc.reloadStored();
	await read.held;
	docs.updateContent('chat.pipe', { name: 'Edited during the reload', components: [] });
	read.release();
	assert.equal(await reloading, false, 'the edit stays');
	assert.equal(content().name, 'Edited during the reload');
	await assert.rejects(doc.save(content()), StaleWriteError);
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Teammate');

	// step: Reload again, with nothing edited meanwhile, shows the change
	assert.equal(await doc.reloadStored(), true);
	assert.deepEqual([content().name, docs.getState().documents['chat.pipe']?.dirty], ['Teammate', false]);
	leave();
});

// =============================================================================
// A SAVE CALLED WHILE A SAVE RUNS — Ctrl+S again, and the agent's Save mine first
// =============================================================================

test('Ctrl+S on a canvas again while its save is on its way waits for that save, and is not refused as a change from outside this editor', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	const write = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await write.held;

	// step: the second Ctrl+S saves the same pipeline: it is the first save, and the document stays saving
	const second = editorControl(ws.view, path)?.save();
	await flush();
	assert.equal(doc.saving, true, 'still saving: the first write has not landed');
	write.release();
	await first;
	await second;
	assert.deepEqual(failures, []);
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Mine');
	assert.equal(s.writes.filter((p) => p === pipePath).length, 1, 'one store write');
	assert.deepEqual([docs.getState().documents['chat.pipe']?.dirty, doc.saving, doc.version], [false, false, ws.view.version(path)]);
	leave();
});

test('Ctrl+S on a canvas again with newer changes while its save is on its way saves them after it, at the version that save wrote', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const firstWrite = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await firstWrite.held;

	// step: the user changes the canvas and saves again; that save waits for the first one
	docs.updateContent('chat.pipe', { name: 'Saved, then more', components: [] });
	const second = editorControl(ws.view, path)?.save();
	const secondWrite = holdWrite(s, pipePath);
	firstWrite.release();
	await first;
	await secondWrite.held;
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Saved');
	assert.equal(doc.saving, true, 'still saving: the second write has not landed');
	secondWrite.release();
	await second;
	assert.deepEqual(failures, []);
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Saved, then more');
	assert.deepEqual([docs.getState().documents['chat.pipe']?.dirty, doc.saving, doc.version], [false, false, ws.view.version(path)]);
	leave();
});

test('Ctrl+S in a text tab again with newer typing while its save is on its way saves the typing after it, at the version that save wrote', { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // saved');
	const firstWrite = holdWrite(s, s.a);
	const first = doc.save();
	await firstWrite.held;

	// step: the user types and saves again; that save waits for the first one
	doc.type('const probe = 1; // saved, then more');
	const second = doc.save();
	const secondWrite = holdWrite(s, s.a);
	firstWrite.release();
	await first;
	await Promise.race([secondWrite.held, second]);
	assert.equal(doc.saving, true, 'still saving: the second write has not landed');
	secondWrite.release();
	await second;
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved, then more');
	assert.deepEqual([doc.dirty, doc.stale, doc.saving, doc.version], [false, false, false, ws.view.version(path)]);
	close();
});

test("the agent's Save mine first while a text tab's save is on its way saves the typing since then after it, and the edit lands on that text", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const files = new FilesystemTools(ws.view, undefined, undefined, { choose: async () => 'save', editor: (p) => editorControl(ws.view, p) });
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: the user types and saves, and types more while the write is on its way; the agent edits the file, and the user answers Save mine first
	doc.type('const probe = 1; // mine');
	const write = holdWrite(s, s.a);
	const saving = doc.save();
	await write.held;
	doc.type('const probe = 1; // mine, then more');
	const editing = tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' });
	await flush();
	write.release();
	await saving;
	assert.match(String(await editing), /^Replaced 1 occurrence\(s\) in apps\/probe\.txt\./);
	assert.equal(s.files.get(s.a), 'const probe = 2; // mine, then more');
	close();
});

test("the agent's Save mine first while a canvas's save is on its way waits for that save, and the edit lands on the saved pipeline", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const path = 'pipelines/chat.pipe';
	const files = new FilesystemTools(ws.view, undefined, undefined, { choose: async () => 'save', editor: (p) => editorControl(ws.view, p) });
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });

	// step: the user changes the canvas and saves; while the write is on its way the agent edits the pipeline, and the user answers Save mine first
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	const write = holdWrite(s, pipePath);
	const saving = editorControl(ws.view, path)?.save();
	await write.held;
	const editing = tool('edit_file', { path, oldString: '"components": []', newString: '"components": [],\n  "note": "agent"' });
	await flush();
	write.release();
	await saving;
	assert.match(String(await editing), /^Replaced 1 occurrence\(s\) in pipelines\/chat\.pipe\./);
	assert.deepEqual(failures, []);
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'Mine', components: [], note: 'agent' });
	leave();
});

// =============================================================================
// A SAVE THE USER DROPPED — Discard mine, Reload, Overwrite and close while a save waits its turn
// =============================================================================

/**
 * Records every content the store is given for a path. Set it up before any
 * holdWrite of the path, so a held write is recorded when it lands.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns The contents, in the order they landed.
 */
function storeWrites(s: ReturnType<typeof storage>, path: string): string[] {
	const landed: string[] = [];
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (p: string, value: string) => {
		await write(p, value);
		if (p === path) landed.push(value);
	};
	return landed;
}

/**
 * A pipeline open on a canvas whose save is PipelineProvider's: it saves
 * what Documents holds, records its failure and rethrows. A save the user
 * dropped is no failure (performSave shows nothing for it), but it rethrows
 * too.
 *
 * @param s - The fake store.
 * @param ws - The workspace.
 * @param pipeline - What the stored pipeline holds.
 */
async function openCanvas(s: ReturnType<typeof storage>, ws: Workspace, pipeline: unknown) {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.files.set(pipePath, JSON.stringify(pipeline, null, 2));
	const docs = new Documents(createDocumentsVfs(s.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content;
	const dirty = () => docs.getState().documents['chat.pipe']?.dirty;
	const failures: unknown[] = [];
	const leave = doc.open(async () => {
		try {
			await doc.save(content());
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) failures.push(err);
			throw err;
		}
	});
	return { docs, doc, pipePath, content, dirty, failures, leave, landed: storeWrites(s, pipePath) };
}

/** The names of the pipelines the store was given, in order. */
function names(landed: string[]): string[] {
	return landed.map((content) => (JSON.parse(content) as { name: string }).name);
}

test("the agent's Discard mine while a canvas's second save waits its turn drops that save, so the deletion the user discarded is not written and the edit lands on the first save", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [], keep: 'saved line' });
	const path = 'pipelines/chat.pipe';
	let asked = 0;
	const files = new FilesystemTools(ws.view, undefined, undefined, {
		choose: async () => {
			asked += 1;
			return 'discard';
		},
		editor: (p) => editorControl(ws.view, p),
	});
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
	await tool('read_file', { path });

	// step: the user saves; while the write is on its way they delete the saved field and press Ctrl+S again, and that save waits its turn
	docs.updateContent('chat.pipe', { name: 'First save', components: [], keep: 'saved line' });
	const write = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Second save', components: [] });
	const queued = editorControl(ws.view, path)?.save();

	// step: the agent edits the pipeline, and the user answers Discard mine before the first write lands
	const editing = tool('edit_file', { path, oldString: '"components": []', newString: '"components": [],\n  "agent": true' });
	await flush();
	assert.equal(asked, 1);
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	assert.match(String(await editing), /^Replaced 1 occurrence\(s\) in pipelines\/chat\.pipe\./);
	await flush();
	const stored = { name: 'First save', components: [], agent: true, keep: 'saved line' };
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), stored, 'the saved field stays');
	assert.deepEqual(names(landed), ['First save', 'First save'], 'the first save, then the edit: the deletion is never written');
	assert.deepEqual([content(), dirty(), doc.saving], [stored, false, false], 'the canvas shows the stored pipeline, clean');
	assert.deepEqual(failures, [], 'the dropped save shows no failure');
	leave();
});

test('a canvas Reload while a second save waits its turn drops that save, and a save of the same pipeline after the Reload is a new save that writes it', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const queued = editorControl(ws.view, path)?.save();

	// step: the user clicks Reload before the first write lands; the reload reads the pipeline once the write is done
	const reloading = doc.reloadStored();
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	assert.equal(await reloading, true);
	assert.deepEqual(names(landed), ['Saved'], 'the dropped pipeline is never written');
	assert.deepEqual([(content() as { name: string }).name, dirty(), doc.saving], ['Saved', false, false]);

	// step: the user saves, and while the write is on its way changes the pipeline, presses Ctrl+S and clicks Reload. During the
	// reload's read they make the same change again, which Documents keeps over the read, and save it: a new save, at the version the write left
	docs.updateContent('chat.pipe', { name: 'Saved, then more', components: [] });
	const again = holdWrite(s, pipePath);
	const third = editorControl(ws.view, path)?.save();
	await again.held;
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const fourth = editorControl(ws.view, path)?.save();
	const dropping = doc.reloadStored();
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const fifth = editorControl(ws.view, path)?.save();
	again.release();
	await third;
	await assert.rejects(fourth!, SaveDroppedError);
	assert.equal(await dropping, false, 'the typing during the reload stays');
	await fifth;
	assert.deepEqual(names(landed), ['Saved', 'Saved, then more', 'Dropped'], 'the save after the Reload wrote the pipeline, at the version the save before it left');
	assert.deepEqual([dirty(), doc.saving, doc.version], [false, false, ws.view.version(path)]);
	assert.deepEqual(failures, []);
	leave();
});

test("a canvas's Overwrite drops the saves waiting their turn, so an older pipeline is not written and shows no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Older', components: [] });
	const queued = editorControl(ws.view, path)?.save();

	// step: the user changes the canvas again and picks Overwrite before the first write lands
	docs.updateContent('chat.pipe', { name: 'Overwritten', components: [] });
	const overwriting = doc.save(content(), { overwrite: true });
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	await overwriting;
	assert.deepEqual(names(landed), ['Saved', 'Overwritten'], 'the older pipeline is never written');
	assert.deepEqual([dirty(), doc.saving, doc.version], [false, false, ws.view.version(path)]);
	assert.deepEqual(failures, []);
	leave();
});

test("closing a canvas with Don't Save while a second save waits its turn drops that save, so the pipeline the user chose not to save is not written", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = editorControl(ws.view, path)?.save();
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Not saved', components: [] });
	const queued = editorControl(ws.view, path)?.save();

	// step: the user closes the tab, and the shell's dirty-close dialog's Don't Save drops the pipeline with its last view
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	leave();
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	await flush();
	assert.deepEqual(names(landed), ['Saved'], 'the pipeline the user chose not to save is never written');
	assert.equal(JSON.parse(s.files.get(pipePath) as string).name, 'Saved');
	assert.deepEqual([doc.saving, failures], [false, []]);
	assert.equal(ws.view.isDirty(path), false);
});

test("the agent's Discard mine while a canvas's Overwrite reads the stored pipeline drops the Overwrite, so the agent's change stays", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: the agent changes the pipeline, so the canvas's save asks Reload or Overwrite
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await assert.rejects(doc.save(content()), StaleWriteError);

	// step: the user picks Overwrite; its read of the stored pipeline is slow, and meanwhile the agent asks again and the user answers Discard mine
	const read = holdRead(s, pipePath);
	const overwriting = doc.save(content(), { overwrite: true });
	await read.held;
	const discarding = editorControl(ws.view, path)?.discard();
	read.release();
	await assert.rejects(overwriting, SaveDroppedError);
	await discarding;
	await flush();
	assert.deepEqual(names(landed), ['Agent'], 'the Overwrite wrote nothing');
	assert.deepEqual([(content() as { name: string }).name, dirty(), doc.saving], ['Agent', false, false], 'the canvas shows the stored pipeline');
	leave();
});

test("Discard mine while a text tab's second save waits its turn drops that save, so typing after it is not saved over the first save, and the tab asks", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const landed = storeWrites(s, s.a);
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: the user types and saves; while the write is on its way they type more and press Ctrl+S again, and that save waits its turn
	doc.type('const probe = 1; // saved');
	const write = holdWrite(s, s.a);
	const first = doc.save();
	await write.held;
	doc.type('const probe = 1; // saved, then dropped');
	const queued = doc.save();

	// step: the user answers Discard mine (the agent's question runs the editors' discard), then types on the stored text the tab shows
	await editorControl(ws.view, path)?.discard();
	assert.equal(doc.text, 'const probe = 1;');
	doc.type('const probe = 1; // typed after the discard');
	write.release();
	await first;
	await assert.rejects(queued, SaveDroppedError);
	await flush();
	assert.deepEqual(landed, ['const probe = 1; // saved'], 'neither the dropped text nor the typing after the discard is written');
	assert.deepEqual([doc.text, doc.dirty, doc.stale, doc.saving], ['const probe = 1; // typed after the discard', true, true, false], 'the typing stays, and the tab asks Reload or Overwrite: it does not hold the first save');
	await assert.rejects(doc.save(), StaleWriteError);
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved');
	close();
});

test("the banner's Reload while a text tab's Overwrite reads the stored file drops the Overwrite, so the teammate's change stays and the tab shows it", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	s.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	const landed = storeWrites(s, s.a);

	// step: the user picks Overwrite; its read of the server's copy is slow, and the user clicks Reload meanwhile
	const read = holdRead(s, s.a);
	const overwriting = doc.save(true);
	await read.held;
	const reloading = doc.discard();
	read.release();
	await assert.rejects(overwriting, SaveDroppedError);
	await reloading;
	await flush();
	assert.deepEqual(landed, [], 'the Overwrite wrote nothing');
	assert.equal(s.files.get(s.a), 'const probe = 2; // teammate');
	assert.deepEqual([doc.text, doc.dirty, doc.stale, doc.saving], ['const probe = 2; // teammate', false, false, false]);
	close();
});

test("a text tab's second Overwrite drops the first one and the save waiting its turn, so only the text at the second click is written", { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	s.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	const landed = storeWrites(s, s.a);

	// step: the user picks Overwrite and its read of the server's copy is slow; they type, press Ctrl+S, and pick Overwrite again
	const read = holdRead(s, s.a);
	const first = doc.save(true);
	await read.held;
	doc.type('const probe = 1; // mine, then more');
	const queued = doc.save();
	const second = doc.save(true);
	read.release();
	await assert.rejects(first, SaveDroppedError);
	await assert.rejects(queued, SaveDroppedError);
	await second;
	assert.deepEqual(landed, ['const probe = 1; // mine, then more'], 'the text at the first click is never written');
	assert.deepEqual([doc.dirty, doc.stale, doc.saving, doc.saveError], [false, false, false, null]);
	close();
});

test('closing the last tab of a text file while a second save waits its turn keeps that save: the text outlives its tab, so it is saved', { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // saved');
	const write = holdWrite(s, s.a);
	const first = doc.save();
	await write.held;
	doc.type('const probe = 1; // saved, then more');
	const queued = doc.save();
	close();
	write.release();
	await first;
	await queued;
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved, then more');
	assert.deepEqual([doc.dirty, doc.saving], [false, false]);
	assert.equal(editorControl(ws.view, path), null, 'the saved document had no tab, so it went');
});

// =============================================================================
// A SAVE THAT OUTLIVES ITS CANVAS: a move, a split, a layout change and a team switch keep it
// =============================================================================

/**
 * Mounts a canvas on the pipeline the way useCanvasDocument does: it finds
 * the pipeline's document, or a new one, and joins it with
 * PipelineProvider's save, which records a failure (a dropped save is none)
 * and rethrows.
 *
 * @param s - The fake store.
 * @param ws - The workspace.
 * @param docs - The Documents that holds the pipeline.
 * @param failures - Where the canvas's failures go.
 */
async function mountCanvas(s: ReturnType<typeof storage>, ws: Workspace, docs: Documents, failures: unknown[]) {
	const { canvasDocument } = (await import(CANVAS_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.client as never);
	const leave = doc.open(async () => {
		try {
			await doc.save(docs.getState().documents['chat.pipe']?.content);
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) failures.push(err);
			throw err;
		}
	});
	return { doc, leave };
}

/** How a promise settled: 'saved' when it resolved, else what it rejected with. */
function outcome(work: Promise<unknown> | undefined): Promise<unknown> {
	return (work ?? Promise.resolve()).then(
		() => 'saved',
		(err: unknown) => err
	);
}

/**
 * Saves a pipeline, then, while that write is held, changes it and saves
 * again, so the second save waits its turn (Ctrl+S twice).
 *
 * @param s - The fake store.
 * @param ws - The workspace.
 * @param docs - The Documents that holds the pipeline.
 * @param pipePath - The pipeline's store path.
 * @returns The two saves, and lets the first write land.
 */
async function twoSaves(s: ReturnType<typeof storage>, ws: Workspace, docs: Documents, pipePath: string) {
	docs.updateContent('chat.pipe', { name: 'First', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(editorControl(ws.view, 'pipelines/chat.pipe')?.save());
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Second', components: [] });
	const second = outcome(editorControl(ws.view, 'pipelines/chat.pipe')?.save());
	return { first, second, release: write.release };
}

test("moving a canvas's tab to another group while its second save waits its turn keeps that save, so the pipeline saved last is stored", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the user drags the tab into another group. React unmounts the canvas from the old group and mounts it in
	// the new one, and Documents keeps the pipeline throughout
	docs.moveEditor(Object.keys(docs.getState().editors)[0], docs.splitGroup(docs.getState().activeGroupId, 'horizontal'));
	leave();
	const moved = await mountCanvas(s, ws, docs, failures);
	release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First', 'Second'], 'the second save is written after the first');
	assert.equal(moved.doc, doc, 'the moved canvas joins the same document');
	assert.deepEqual([(content() as { name: string }).name, dirty(), doc.saving, doc.version], ['Second', false, false, ws.view.version(path)], 'the canvas shows the stored pipeline, clean, at its version');
	assert.deepEqual(failures, []);
	moved.leave();
});

test("splitting a canvas's group while its second save waits its turn keeps that save, and both splits end clean", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the user splits the group. The canvas's pane moves under the split, so React mounts it again, and a second canvas opens beside it
	docs.splitGroupWithDocument(docs.getState().activeGroupId, 'horizontal');
	leave();
	const left = await mountCanvas(s, ws, docs, failures);
	const right = await mountCanvas(s, ws, docs, failures);
	release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First', 'Second']);
	assert.deepEqual([left.doc === doc, right.doc === doc], [true, true], 'both splits share the document');
	assert.deepEqual([dirty(), doc.saving, failures], [false, false, []]);
	left.leave();
	right.leave();
});

test('closing one of two splits of a canvas while its second save waits its turn keeps that save: the other split mounts again', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const beside = docs.splitGroupWithDocument(docs.getState().activeGroupId, 'horizontal');
	leave();
	const kept = await mountCanvas(s, ws, docs, failures);
	const closing = await mountCanvas(s, ws, docs, failures);
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the user closes the second split. Documents keeps the pipeline in the first, whose pane moves up out of the
	// split, so React unmounts both canvases and mounts the first again
	docs.closeGroup(beside);
	closing.leave();
	kept.leave();
	const again = await mountCanvas(s, ws, docs, failures);
	release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First', 'Second']);
	assert.equal(again.doc, doc);
	assert.deepEqual([dirty(), doc.saving, failures], [false, false, []]);
	again.leave();
});

test("a team switch while a canvas's second save waits its turn keeps that save in the team it was called in", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the user switches team. RocketApp tears Documents down, which unmounts every canvas, and builds the new
	// team's workspace, which parks the old one: a write that starts after it stays staged there
	docs.destroy();
	leave();
	await workspace(s.beta);
	release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First'], 'the first save had reached the store');
	assert.equal(JSON.parse(String(await ws.view.read(path))).name, 'Second', "the second is staged in the old team's workspace, which a return to the team brings back");
	assert.equal(s.files.get(`@/Team/=${s.beta}/.projects/chat.pipe`), undefined, 'the new team is untouched');
	assert.deepEqual([doc.saving, failures], [false, []]);
	assert.equal(editorControl(ws.view, path), null, "no canvas shows the old team's pipeline, so it guards nothing");
});

test("closing a canvas with Don't Save drops its waiting save even when the save's turn comes before the canvas unmounts", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the shell's dirty-close dialog's Don't Save drops the pipeline from Documents. The first write lands before
	// React unmounts the canvas
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	release();
	const [firstOutcome, secondOutcome] = [await first, await second];
	leave();
	await flush();
	assert.deepEqual(names(landed), ['First'], 'the pipeline the user chose not to save is never written');
	assert.deepEqual([firstOutcome, secondOutcome instanceof SaveDroppedError], ['saved', true]);
	assert.deepEqual(failures, []);
});

test('moving a text tab while a second save waits its turn keeps that save: the unsaved text keeps its document', { timeout: 10_000 }, async () => {
	const { fileDocument } = (await import(FILE_DOCUMENT)) as typeof import('../../../../rocket-ui/src/surfaces/workspace/fileDocument');
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	doc.type('const probe = 1; // saved');
	const write = holdWrite(s, s.a);
	const first = outcome(doc.save());
	await write.held;
	doc.type('const probe = 1; // saved, then more');
	const second = outcome(doc.save());

	// step: the tab moves to another group: FileProvider unmounts and mounts again, and finds the same document
	close();
	const moved = fileDocument(ws.view, path);
	const closeMoved = moved.open();
	void moved.load();
	write.release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.equal(moved, doc);
	assert.equal(s.files.get(s.a), 'const probe = 1; // saved, then more');
	assert.deepEqual([doc.text, doc.dirty, doc.saving, doc.saveError], ['const probe = 1; // saved, then more', false, false, null]);
	closeMoved();
});

// =============================================================================
// WHAT WAITS ON A SAVE: Save & Run, publish, Save mine first and the close dialog's Save stop when it is dropped
// =============================================================================

/**
 * PipelineProvider's performSave: a failure is recorded (the canvas shows
 * it), a dropped save is not, and with rethrow both reject.
 *
 * @param doc - The pipeline's document.
 * @param project - The pipeline to save.
 * @param failures - Where the shown failures go.
 * @param rethrow - Reject when the save did not land, for a caller that waits on it.
 */
async function performSave(doc: { save(content: unknown): Promise<void> }, project: unknown, failures: unknown[], rethrow: boolean): Promise<void> {
	try {
		await doc.save(project);
	} catch (err) {
		if (err instanceof SaveDroppedError) {
			if (rethrow) throw err;
			return;
		}
		failures.push(err);
		if (rethrow) throw err;
	}
}

/**
 * Save & Run, as PipelineProvider's handleSaveAndRun makes it: performSave
 * with rethrow, then the run of the pipeline it saved.
 *
 * @param doc - The pipeline's document.
 * @param project - The pipeline at the click.
 * @param failures - Where the shown failures go.
 * @param runs - Each pipeline that ran.
 */
function saveAndRun(doc: { save(content: unknown): Promise<void> }, project: unknown, failures: unknown[], runs: unknown[]): Promise<void> {
	return performSave(doc, project, failures, true)
		.then(() => void runs.push(project))
		.catch(() => undefined);
}

/**
 * The agent's file tools over a workspace, with a dialog that gives one answer.
 *
 * @param ws - The workspace.
 * @param answer - What the user answers.
 */
function agentTools(ws: Workspace, answer: 'save' | 'discard') {
	const files = new FilesystemTools(ws.view, undefined, undefined, { choose: async () => answer, editor: (p) => editorControl(ws.view, p) });
	return (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);
}

test("Save & Run whose write fails after the agent's Discard mine dropped its pipeline runs nothing and shows no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const tool = agentTools(ws, 'discard');
	await tool('read_file', { path });

	// step: the user picks Save & Run and its write is held, then fails
	docs.updateContent('chat.pipe', { name: 'Mine to discard', components: [] });
	const [held, landing] = [deferred(), deferred()];
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (p: string, value: string) => {
		if (p === pipePath) {
			s.client.fsWriteString = write;
			held.resolve();
			await landing.promise;
			throw new Error('network failure');
		}
		return write(p, value);
	};
	const runs: unknown[] = [];
	const running = saveAndRun(doc, content(), failures, runs);
	await held.promise;

	// step: the agent edits the pipeline, and the user answers Discard mine while the write is held
	const editing = tool('edit_file', { path, oldString: '"components": []', newString: '"components": [], "agent": true' });
	await flush();
	landing.resolve();
	await running;
	await outcome(editing);
	await flush();
	const stored = { name: 'Original', components: [], agent: true };
	assert.deepEqual(runs, [], 'the discarded pipeline never reached the store, so nothing runs');
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), stored);
	assert.deepEqual([content(), dirty()], [stored, false], 'the canvas shows the stored pipeline, clean');
	assert.deepEqual(failures, [], 'the dropped save shows no failure');
	leave();
});

test("Save & Run whose save waits its turn and that the agent's Discard mine drops runs nothing and shows no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const tool = agentTools(ws, 'discard');
	await tool('read_file', { path });

	// step: the user saves, and while the write is held changes the pipeline and picks Save & Run, whose save waits its turn
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(editorControl(ws.view, path)?.save());
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Mine to discard', components: [] });
	const runs: unknown[] = [];
	const running = saveAndRun(doc, content(), failures, runs);

	// step: the agent edits, and the user answers Discard mine before the first write lands
	const editing = tool('edit_file', { path, oldString: '"components": []', newString: '"components": [], "agent": true' });
	await flush();
	write.release();
	assert.equal(await first, 'saved');
	await running;
	await outcome(editing);
	await flush();
	assert.deepEqual(runs, [], 'nothing runs the pipeline the user discarded');
	assert.deepEqual(names(landed), ['Saved', 'Saved'], 'the first save, then the edit');
	assert.deepEqual(failures, []);
	leave();
});

test("Save & publish whose save the agent's Discard mine drops while it waits publishes nothing and shows no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, failures, leave } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const tool = agentTools(ws, 'discard');
	await tool('read_file', { path });
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(editorControl(ws.view, path)?.save());
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Mine to discard', components: [] });

	// step: the user clicks Save & publish, as DeployPanel runs it over PipelineProvider's host: the save, then the publish of
	// the pipeline at the click. A failure shows under the dialog; a dropped save shows nothing
	const published: unknown[] = [];
	const shown: unknown[] = [];
	const snapshot = content();
	const publishing = (async () => {
		try {
			await performSave(doc, snapshot, failures, true);
			published.push(snapshot);
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) shown.push(err);
		}
	})();
	const editing = tool('edit_file', { path, oldString: '"components": []', newString: '"components": [], "agent": true' });
	await flush();
	write.release();
	assert.equal(await first, 'saved');
	await publishing;
	await outcome(editing);
	assert.deepEqual(published, [], 'nothing publishes the pipeline the user discarded');
	assert.deepEqual([shown, failures], [[], []], 'and nothing shows a failure');
	leave();
});

test("the agent's Save mine first that waits its turn, and that the user's Don't Save close drops, refuses the edit and says the changes were not saved", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const tool = agentTools(ws, 'save');
	await tool('read_file', { path });
	docs.updateContent('chat.pipe', { name: 'First', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(editorControl(ws.view, path)?.save());
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: the agent edits and the user answers Save mine first, whose save waits its turn. Then the user closes the tab
	// and answers the shell's dirty-close dialog Don't Save
	const editing = outcome(tool('edit_file', { path, oldString: '"components": []', newString: '"components": [], "agent": true' }));
	await flush();
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	leave();
	write.release();
	assert.equal(await first, 'saved');
	const result = await editing;
	await flush();
	assert.deepEqual(names(landed), ['First'], 'neither the pipeline the user did not save nor an edit on top of it is written');
	assert.ok(result instanceof Error && /were not saved/.test(result.message), `the agent is told the changes were not saved (got ${String(result)})`);
	assert.deepEqual(failures, []);
});

test("the close dialog's Save that waits its turn, and that the agent's Discard mine drops, keeps the tab open with no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const path = 'pipelines/chat.pipe';
	const tool = agentTools(ws, 'discard');
	await tool('read_file', { path });
	docs.updateContent('chat.pipe', { name: 'First', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(editorControl(ws.view, path)?.save());
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: the user closes the tab and answers Save, whose save waits its turn; the agent edits and the user answers Discard mine
	const closing = docs.requestCloseEditor(Object.keys(docs.getState().editors)[0]);
	await flush();
	const editing = outcome(tool('edit_file', { path, oldString: '"components": []', newString: '"components": [], "agent": true' }));
	await flush();
	write.release();
	assert.equal(await first, 'saved');
	assert.equal(await closing, false, 'the close is abandoned: its save did not land');
	await editing;
	await flush();
	assert.deepEqual(JSON.parse(s.files.get(pipePath) as string), { name: 'First', components: [], agent: true });
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, false, 'the tab stays open, clean, on the stored pipeline');
	assert.deepEqual(failures, []);
	leave();
});

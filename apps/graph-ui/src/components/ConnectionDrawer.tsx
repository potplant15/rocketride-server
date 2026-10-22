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
// GRAPH-UI - CONNECTION DRAWER (inspect and test one graph endpoint)
// =============================================================================
//
// Shows what the node says about itself (engine, version, graph or database,
// whether writes are allowed, how reads are kept read-only) and the endpoint's own
// pipeline, run kind and owner. "Test connection" asks the node's `dialect` tool
// again through the shared store; nothing here holds or shows a credential.
//
// The full app opens it from a Connections card, over the window. As a dev tool
// there is no landing: a connection's own document opens it (`contained`,
// anchored to the document), without "Open workbench" inside the workbench.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, DetailPanel, LabelValue, Section, StatusBadge } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { connectionView, testResultText } from '../graph/connections';
import type { ITestResult } from '../graph/connections';
import { GraphIcon } from '../icons';

/** Props. */
export interface IConnectionDrawerProps {
	open: boolean;
	endpoint: IExplorerEndpoint | null;
	probe: IProbeResult | undefined;
	/** Re-probe the endpoint; resolves with the new result (null when nothing was sent: no running task, or a check already running). */
	onTest(endpoint: IExplorerEndpoint): Promise<IProbeResult | null>;
	/** Open the connection's workbench; omitted inside the workbench itself (no button then). */
	onOpen?(endpoint: IExplorerEndpoint): void;
	onClose(): void;
	/** Anchor the drawer to the nearest positioned ancestor (a dev-tool document) instead of the window. */
	contained?: boolean;
	/** Run Test connection as soon as the drawer opens (it was opened by a "Test connection" action). */
	testOnOpen?: boolean;
}

/**
 * The drawer.
 *
 * @param props - See {@link IConnectionDrawerProps}.
 * @returns The drawer, or nothing while closed.
 */
export const ConnectionDrawer: React.FC<IConnectionDrawerProps> = ({ open, endpoint, probe, onTest, onOpen, onClose, contained = false, testOnOpen = false }) => {
	const [testing, setTesting] = useState(false);
	// The host keys this drawer on the card it shows, so a result never carries over to another connection.
	const [tested, setTested] = useState<ITestResult | null>(null);
	const autoTested = useRef(false);

	const test = async (target: IExplorerEndpoint): Promise<void> => {
		setTesting(true);
		try {
			const result = await onTest(target);
			setTested(testResultText(result));
		} finally {
			setTesting(false);
		}
	};

	// Opened by "Test connection": test at once, once per drawer (a document mounts a fresh one for every opening; the
	// ref keeps StrictMode's second effect run from sending a second probe).
	useEffect(() => {
		if (!open || !testOnOpen || !endpoint || autoTested.current) return;
		autoTested.current = true;
		void test(endpoint);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening, with the endpoint and handler of that moment
	}, [open, testOnOpen]);

	if (!endpoint) return null;
	const view = connectionView(endpoint, probe);

	return (
		<DetailPanel
			contained={contained}
			open={open}
			onClose={onClose}
			avatar={<GraphIcon />}
			title={view.title}
			subtitle={view.address}
			footer={
				<>
					<Button variant="ghost" disabled={testing} onClick={() => void test(endpoint)}>
						{testing ? 'Testing...' : 'Test connection'}
					</Button>
					{onOpen && (
						<Button variant="primary" disabled={!view.openable} onClick={() => onOpen(endpoint)}>
							Open workbench
						</Button>
					)}
				</>
			}
		>
			<Section label="Status">
				<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
				{view.blocked && (
					<div style={{ marginTop: 12 }}>
						<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{view.blocked}</Banner>
					</div>
				)}
				{tested && <div style={{ marginTop: 12 }}><Banner variant={tested.variant}>{tested.text}</Banner></div>}
			</Section>
			<Section label="Connection">
				{view.details.map((row) => (
					<LabelValue key={row.label} label={row.label}>
						{row.value}
					</LabelValue>
				))}
			</Section>
			{view.notes.length > 0 && (
				<Section label="What to know">
					{view.notes.map((note) => (
						<div key={note} style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
							{note}
						</div>
					))}
				</Section>
			)}
		</DetailPanel>
	);
};

export default ConnectionDrawer;

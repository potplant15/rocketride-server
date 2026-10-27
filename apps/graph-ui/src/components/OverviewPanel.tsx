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

// =============================================================================
// GRAPH-UI - OVERVIEW (a connection's schema at a glance)
// =============================================================================
//
// The workbench's first tab: counts, the schema graph, relationship types and
// label cards, all from the schema already loaded (no request of its own).
// Not drawn yet: it renders nothing.
// =============================================================================

import type React from 'react';
import type { IExplorerEndpoint } from 'shared/explorer';
import type { IGraphDialect } from '../graph/dialect';

/** Props. */
export interface IOverviewPanelProps {
	endpoint: IExplorerEndpoint;
	dialect: IGraphDialect | null;
	/** Open the 25-row preview of a label or relationship type in a new tab. */
	onPreview(kind: 'label' | 'type', name: string): void;
	/** Open a new query tab with this text, not run. */
	onNewQuery(cypher: string, title: string): void;
	/** Open (or show) the Explore tab and run its sample. */
	onExplore(): void;
	onRefreshSchema(): void;
}

/**
 * The Overview.
 *
 * @param _props - See {@link IOverviewPanelProps}.
 * @returns Nothing yet.
 */
export const OverviewPanel: React.FC<IOverviewPanelProps> = (_props) => null;

export default OverviewPanel;

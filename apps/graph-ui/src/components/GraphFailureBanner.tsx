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
// GRAPH-UI - FAILURE BANNER (the shared banner, plus what the graph adds to it)
// =============================================================================
//
// The workbench's failure banner. Today it is the shared Explorer banner as is
// (shared/explorer/components/FailureBanner, which is not ours to edit); the
// graph's additions (a "run from here" action for a batch that stopped part
// way) come in through the extra props, which it does not use yet.
// =============================================================================

import React from 'react';
import FailureBanner from 'shared/explorer/components/FailureBanner';
import type { IFailureBannerProps } from 'shared/explorer/components/FailureBanner';
import type { IFailureNotice } from 'shared/explorer';

/** Props: the shared banner's, plus the graph's own. */
export interface IGraphFailureBannerProps<TNotice extends IFailureNotice> extends IFailureBannerProps<TNotice> {
	/** Run the batch again from the statement at this index (not offered yet). */
	onRunFrom?(index: number): void;
}

/**
 * The failure banner.
 *
 * @param props - {@link IGraphFailureBannerProps}.
 * @returns The banner element.
 */
export function GraphFailureBanner<TNotice extends IFailureNotice>({ failure, genericText, extra, saidLabel }: IGraphFailureBannerProps<TNotice>): React.ReactElement {
	return <FailureBanner failure={failure} genericText={genericText} extra={extra} saidLabel={saidLabel} />;
}

export default GraphFailureBanner;

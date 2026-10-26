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
// SQL-UI — GATED BUTTON (a button that says why it is off)
// =============================================================================
//
// The shell Button takes `disabled` and a tooltip, but has no way to say
// "unavailable, and here is why" to assistive technology. This wraps it: the
// wrapper carries aria-disabled and points at the visible reason text, the
// button inside is disabled, and the tooltip repeats the reason.
// =============================================================================

import React from 'react';
import { Button } from 'shell';
import type { IButtonProps } from 'shell';

/** Props for the {@link GatedButton} component. */
export interface GatedButtonProps extends IButtonProps {
	/** Why the button is unavailable (null/undefined = no gate, behaves as Button). */
	gateReason?: string | null;
	/** Id of the visible element that carries the reason, for aria-describedby. */
	reasonId?: string;
}

/**
 * A Button that is disabled with a stated reason while `gateReason` is set.
 *
 * @param props - {@link GatedButtonProps}.
 * @returns The button, wrapped when gated.
 */
export const GatedButton: React.FC<GatedButtonProps> = ({ gateReason, reasonId, ...button }) => {
	if (!gateReason) return <Button {...button} />;
	return (
		<span style={{ display: 'inline-flex' }} aria-disabled="true" aria-describedby={reasonId} title={gateReason}>
			<Button {...button} disabled title={gateReason} />
		</span>
	);
};

export default GatedButton;

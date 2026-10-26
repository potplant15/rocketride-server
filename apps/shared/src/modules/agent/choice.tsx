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
// CHOICE — the unsaved-changes prompt: save mine first, discard mine, keep mine
// =============================================================================

/**
 * When the agent wants to change a file the user has unsaved changes in, the
 * user picks one of three answers, the way Zed asks. This mounts the shell's
 * ChoiceDialog the way the shell's confirm service
 * (packages/shell/src/components/modal/confirmService.tsx) mounts it, and
 * resolves the answer. Escape and Keep mine resolve 'keep'. It does not use
 * the service's showChoiceDialog, which offers no way to take a dialog down
 * when the run ends.
 *
 * Questions wait in a queue of our own, so each file gets its own dialog, one
 * after another. A question whose turn comes while a dialog that is not ours
 * is open (a confirm, a save-as) is not shown and resolves 'unasked'. A run
 * that ends takes its questions down as 'keep', so nothing the user answers
 * later lands after the run.
 */

import { createRoot } from 'react-dom/client';
import { ChoiceDialog, type IChoiceOption } from 'shell';

import type { ChoiceFn, UnsavedChoice } from './toolkits/common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The button labels, by the answer each one gives. */
export const CHOICE_LABELS: Readonly<Record<Exclude<UnsavedChoice, 'unasked'>, string>> = { save: 'Save mine first', discard: 'Discard mine', keep: 'Keep mine' };

/**
 * The buttons, left to right. Keep mine is last and none is primary, so the
 * dialog focuses Keep mine: it opens while the user may be typing, and Space
 * or Enter typed into it then changes nothing.
 */
const CHOICE_OPTIONS: readonly IChoiceOption[] = [
	{ id: 'save', label: CHOICE_LABELS.save },
	{ id: 'discard', label: CHOICE_LABELS.discard, destructive: true },
	{ id: 'keep', label: CHOICE_LABELS.keep },
];

/** An open modal dialog, from this service or anyone else. */
const OPEN_DIALOG = '[role="dialog"][aria-modal="true"]';

/** The attribute on the host element of our own dialogs. */
const OWN_DIALOG = 'data-agent-choice';

// =============================================================================
// THE QUEUE
// =============================================================================

/** One question on screen. */
export interface ShownChoice {
	/** Settles with the user's answer. */
	answer: Promise<UnsavedChoice>;
	/** Takes the dialog down without an answer. */
	close: () => void;
}

/**
 * Shows questions one at a time, in the order they are asked. Only this
 * queue decides when the next question may show. A question whose turn comes
 * while a dialog that is not ours is open resolves 'unasked', unshown. A
 * question whose signal aborts resolves 'keep': before its turn it is never
 * shown, and on screen it is taken down.
 *
 * @param show - Puts one question on screen.
 * @param blocked - Whether a dialog that is not ours is open now.
 * @returns The choice function.
 */
export function queueChoices(show: (title: string, message: string) => ShownChoice, blocked: () => boolean = () => false): ChoiceFn {
	let turn: Promise<unknown> = Promise.resolve();
	return (title, message, signal) => {
		const ask = (): Promise<UnsavedChoice> => {
			if (signal?.aborted) return Promise.resolve('keep');
			if (blocked()) return Promise.resolve('unasked');
			const shown = show(title, message);
			if (!signal) return shown.answer;
			return new Promise<UnsavedChoice>((resolve) => {
				const end = (): void => {
					shown.close();
					resolve('keep');
				};
				signal.addEventListener('abort', end, { once: true });
				const answered = (choice: UnsavedChoice): void => {
					signal.removeEventListener('abort', end);
					resolve(choice);
				};
				shown.answer.then(answered, () => answered('keep'));
			});
		};
		const asked = turn.then(ask);
		turn = asked.catch(() => undefined);
		return asked;
	};
}

/**
 * Whether a modal dialog that is not one of ours is open. Our own dialogs are
 * passed over, so the last one, still in the page until its deferred unmount,
 * never blocks the next question.
 *
 * @param root - Where to look (the page by default).
 * @returns True when another dialog is open.
 */
export function otherDialogOpen(root: ParentNode = document): boolean {
	return [...root.querySelectorAll(OPEN_DIALOG)].some((dialog) => !dialog.closest(`[${OWN_DIALOG}]`));
}

// =============================================================================
// THE DIALOG
// =============================================================================

/**
 * Mounts the dialog in this realm.
 *
 * @param title - The dialog title.
 * @param message - What the agent wants to change.
 * @returns The answer, and a way to take the dialog down.
 */
function mountChoice(title: string, message: string): ShownChoice {
	const hostEl = document.createElement('div');
	hostEl.setAttribute(OWN_DIALOG, '');
	document.body.appendChild(hostEl);
	const root = createRoot(hostEl);
	let mounted = true;
	const close = (): void => {
		if (!mounted) return;
		mounted = false;
		// Unmount on a fresh task. React forbids unmounting from inside
		// a render or event of the same root.
		setTimeout(() => {
			root.unmount();
			hostEl.remove();
		}, 0);
	};
	const answer = new Promise<UnsavedChoice>((resolve) => {
		const settle = (choice: UnsavedChoice): void => {
			close();
			resolve(choice);
		};
		root.render(<ChoiceDialog title={title} message={message} options={CHOICE_OPTIONS} onChoose={(id) => settle(id === 'save' || id === 'discard' ? id : 'keep')} onCancel={() => settle('keep')} />);
	});
	return { answer, close };
}

/** Asks the user what to do with their unsaved changes, one dialog at a time. */
export const showChoice: ChoiceFn = queueChoices(mountChoice, () => otherDialogOpen());

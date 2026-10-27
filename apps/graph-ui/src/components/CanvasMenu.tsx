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

// =============================================================================
// GRAPH-UI - CANVAS MENU (the right-click menu and the toolbar's Layout and Export menus)
// =============================================================================
//
// The WAI-ARIA authoring practices menu: `role="menu"` with `menuitem` (or
// `menuitemradio` / `menuitemcheckbox`) children, focus on the first item when it
// opens, Down and Up with wrap, Home and End, Enter and Space, Right into a
// submenu and Left back out, Escape, Tab, and a letter to jump (graph/canvasMenu.ts
// holds the keys). It is drawn inside the element the owner positions it in, so
// it works when the view is maximised, and it adds no listener of its own: the
// owner closes it when a pointer goes down outside it.
//
// A submenu replaces the items in place (with a Back item first) rather than
// opening beside them, so nothing ever sits outside the canvas.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { clampMenuPosition, menuKey } from '../graph/canvasMenu';
import type { IMenuItem } from '../graph/canvasMenu';

/** The id of the Back item a submenu page starts with. */
const BACK_ID = '__back';

/** Props. */
export interface ICanvasMenuProps {
	/** The accessible name. */
	label: string;
	items: readonly IMenuItem[];
	/** The top-left, relative to the element the menu is positioned in. */
	x: number;
	y: number;
	/** When given, the menu is kept inside these bounds (the positioning element's size). */
	bounds?: { width: number; height: number };
	/** An enabled item was chosen (not one that opens a submenu). */
	onActivate(id: string): void;
	/** The menu asks to go away; `restoreFocus` is false when the owner moves focus itself. */
	onClose(restoreFocus: boolean): void;
}

const styles = {
	menu: { position: 'absolute', zIndex: 20, minWidth: 220, maxWidth: 320, padding: '4px 0', background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border)', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.25)', fontSize: 13 } as CSSProperties,
	item: (active: boolean, disabled: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', padding: '5px 12px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, background: active ? 'var(--rr-bg-hover, rgba(127,127,127,0.18))' : 'transparent', outline: 'none', whiteSpace: 'nowrap' }),
	hint: { fontSize: 11.5, color: 'var(--rr-text-secondary)' } as CSSProperties,
	separator: { height: 1, margin: '4px 0', background: 'var(--rr-border)' } as CSSProperties,
};

/**
 * The menu.
 *
 * @param props - See {@link ICanvasMenuProps}.
 * @returns The menu.
 */
export const CanvasMenu: React.FC<ICanvasMenuProps> = ({ label, items, x, y, bounds, onActivate, onClose }) => {
	const root = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
	const [page, setPage] = useState<{ title: string; items: readonly IMenuItem[] } | null>(null);
	const [active, setActive] = useState(0);
	const [at, setAt] = useState({ x, y });

	const shown: readonly IMenuItem[] = page ? [{ id: BACK_ID, label: `‹ ${page.title}` }, ...page.items] : items;

	// Place inside the bounds once the size is known.
	useLayoutEffect(() => {
		const el = root.current;
		if (!bounds || !el) {
			setAt({ x, y });
			return;
		}
		setAt(clampMenuPosition({ x, y }, bounds, { width: el.offsetWidth, height: el.offsetHeight }));
	}, [x, y, bounds, page]);

	// Focus follows the current item (and the first item when the menu opens).
	useEffect(() => {
		itemRefs.current[active]?.focus({ preventScroll: true });
	}, [active, page]);

	const choose = (index: number): void => {
		const item = shown[index];
		if (!item || item.disabled) return;
		if (item.id === BACK_ID) {
			setPage(null);
			setActive(0);
		} else if (item.submenu) {
			setPage({ title: item.label, items: item.submenu });
			setActive(1);
		} else onActivate(item.id);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const result = menuKey(shown, active, event.key);
		if (result.handled) event.preventDefault();
		switch (result.type) {
			case 'move':
				setActive(result.index);
				break;
			case 'activate':
				choose(result.index);
				break;
			case 'open-submenu':
				choose(result.index);
				break;
			case 'back':
				if (page) {
					setPage(null);
					setActive(0);
				}
				break;
			case 'close':
				if (event.key === 'Escape' && page) {
					setPage(null);
					setActive(0);
				} else onClose(true);
				break;
			default:
				break;
		}
	};

	return (
		<div ref={root} role="menu" aria-label={label} style={{ ...styles.menu, left: at.x, top: at.y }} onKeyDown={onKeyDown}>
			{shown.map((item, index) => (
				<React.Fragment key={item.id}>
					{item.separatorBefore && <div role="separator" style={styles.separator} />}
					<div
						ref={(el) => {
							itemRefs.current[index] = el;
						}}
						role={item.role ?? 'menuitem'}
						aria-checked={item.role === 'menuitemradio' || item.role === 'menuitemcheckbox' ? item.checked === true : undefined}
						aria-disabled={item.disabled ? true : undefined}
						aria-haspopup={item.submenu ? 'menu' : undefined}
						title={item.disabled ? item.reason : undefined}
						tabIndex={index === active ? 0 : -1}
						style={styles.item(index === active, item.disabled === true)}
						onClick={() => choose(index)}
						onMouseMove={() => index !== active && setActive(index)}
					>
						<span>
							{item.role === 'menuitemradio' || item.role === 'menuitemcheckbox' ? <span aria-hidden="true" style={{ display: 'inline-block', width: 16 }}>{item.checked ? '✓' : ''}</span> : null}
							{item.label}
						</span>
						<span style={styles.hint}>{item.submenu ? '▸' : item.hint}</span>
					</div>
				</React.Fragment>
			))}
		</div>
	);
};

export default CanvasMenu;

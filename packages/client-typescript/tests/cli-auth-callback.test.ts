/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The page the browser lands on after `rocketride login` (#2850): success
 * closes the tab or continues to the web app — never a dead end the user
 * must close — and failure explains itself without redirecting.
 */

import { describe, expect, it } from '@jest/globals';
import { renderCallbackPage } from '../src/cli/commands/auth';

/** The inline script's body. */
const scriptOf = (page: string): string => /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';

describe('renderCallbackPage', () => {
	it('closes the tab, else continues to the web app, with a visible link', () => {
		const page = renderCallbackPage({ ok: true, webUrl: 'https://api.rocketride.ai/' });

		expect(page).toContain('Signed in to RocketRide.');
		expect(page).toContain('<meta name="color-scheme" content="light dark">');
		expect(scriptOf(page)).toBe('window.close();setTimeout(function(){location.replace("https://api.rocketride.ai/");},300);');
		expect(page).toContain('<a href="https://api.rocketride.ai/">Continue to RocketRide</a>');
		expect(page).not.toContain('You can close this window');
	});

	it('keeps a hostile URL inside the JSON string and out of the markup', () => {
		const page = renderCallbackPage({ ok: true, webUrl: 'https://evil.test/"</script><script>alert(1)</script>' });

		expect(page.match(/<\/script>/g)).toHaveLength(1);
		expect(page).not.toContain('<script>alert(1)');
		expect(scriptOf(page)).not.toMatch(/</);
	});

	it('never redirects to a non-http(s) target', () => {
		for (const webUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', undefined]) {
			const page = renderCallbackPage({ ok: true, webUrl });

			expect(scriptOf(page)).toBe('window.close();');
			expect(page).toContain('You can return to the terminal.');
		}
	});

	it('shows an escaped failure reason with no close or redirect', () => {
		const page = renderCallbackPage({ ok: false, error: 'access_denied <b>by user</b>' });

		expect(page).toContain('RocketRide sign-in failed.');
		expect(page).toContain('access_denied &lt;b&gt;by user&lt;/b&gt;');
		expect(page).not.toContain('<script>');
	});
});

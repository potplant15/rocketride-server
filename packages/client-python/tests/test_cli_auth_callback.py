# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""The post-login callback page (#2850): close or continue to the web app; failures explain themselves (TS renderCallbackPage twin)."""

import re

import pytest

from rocketride.cli.commands.auth import _render_callback_page


def _script_of(page):
    match = re.search(r'<script>([\s\S]*)</script>', page)
    return match.group(1) if match else ''


def test_closes_else_continues_to_the_web_app():
    page = _render_callback_page(True, web_url='https://api.rocketride.ai/')

    assert 'Signed in to RocketRide.' in page
    assert '<meta name="color-scheme" content="light dark">' in page
    assert (
        _script_of(page)
        == 'window.close();setTimeout(function(){location.replace("https://api.rocketride.ai/");},300);'
    )
    assert '<a href="https://api.rocketride.ai/">Continue to RocketRide</a>' in page
    assert 'You can close this window' not in page


def test_hostile_url_stays_inside_the_json_string():
    page = _render_callback_page(True, web_url='https://evil.test/"</script><script>alert(1)</script>')

    assert page.count('</script>') == 1
    assert '<script>alert(1)' not in page
    assert '\\u003c' in _script_of(page)


@pytest.mark.parametrize('web_url', ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', None])
def test_never_redirects_to_a_non_http_target(web_url):
    page = _render_callback_page(True, web_url=web_url)

    assert _script_of(page) == 'window.close();'
    assert 'You can return to the terminal.' in page


def test_failure_is_escaped_with_no_script():
    page = _render_callback_page(False, error='access_denied <b>by user</b>')

    assert 'RocketRide sign-in failed.' in page
    assert 'access_denied &lt;b&gt;by user&lt;/b&gt;' in page
    assert '<script>' not in page

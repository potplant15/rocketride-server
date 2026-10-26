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

"""deploy.create_app defaults the app-id namespace to the connected org's developer id (TS twin parity)."""

import pytest

from rocketride import _app_scaffold
from rocketride.deploy import DeployApi


class _FakeClient:
    """Just enough client for create_app: connection info and the cached login result."""

    def __init__(self, account_info):
        self._account_info = account_info

    def get_connection_info(self):
        return {'uri': ''}

    def get_account_info(self):
        return self._account_info


@pytest.fixture
def captured(monkeypatch):
    """Capture the developer_id create_app hands to the scaffold."""
    calls = {}

    def fake_create_app_workspace(workspace_root, slug, **kwargs):
        calls['developer_id'] = kwargs['developer_id']
        return {'appId': f'{kwargs["developer_id"] or "local"}.{slug}'}

    monkeypatch.setattr(_app_scaffold, 'create_app_workspace', fake_create_app_workspace)
    return calls


async def test_uses_the_org_developer_id(captured):
    await DeployApi(_FakeClient({'organization': {'developerId': 'acme'}})).create_app('clock', install=False)

    assert captured['developer_id'] == 'acme'


async def test_explicit_developer_id_wins(captured):
    await DeployApi(_FakeClient({'organization': {'developerId': 'acme'}})).create_app(
        'clock', developer_id='other', install=False
    )

    assert captured['developer_id'] == 'other'


@pytest.mark.parametrize('account_info', [None, {}, {'organization': None}, {'organization': {'developerId': None}}])
async def test_falls_through_to_the_scaffold_default(captured, account_info):
    await DeployApi(_FakeClient(account_info)).create_app('clock', install=False)

    assert captured['developer_id'] is None

"""Regression test: a version must not be permanently skipped when the
AI Task classification fails.

test_translate_changelog.py already covers _translate_changelog returning
the _AI_CLASSIFICATION_UNKNOWN sentinel in isolation. This test covers the
caller-side consequence of that sentinel inside async_setup_entry's state-
changed handler (_process_state -> _process_state_inner), which was
previously untested: per that function's own comment, an unknown
classification must NOT be recorded in the 'notified' store, so the
version is re-evaluated on the next state change instead of being
silently treated as handled forever.

No pytest-homeassistant-custom-component fixture, consistent with the
rest of this repo's tests: hass is a lightweight MagicMock, Store's real
disk I/O is patched out, and the GitHub fetch is patched out so this
test only exercises the classification-failure/retry logic, not network
code already covered elsewhere.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.const import EVENT_STATE_CHANGED

from custom_components.changelog_traduction import async_setup_entry


def run(coro):
    return asyncio.run(coro)


def _make_state():
    state = MagicMock()
    state.attributes = {
        "latest_version": "2.0.0",
        "release_url": "https://github.com/owner/repo/releases/tag/v2.0.0",
        "entity_picture": "",
        "title": "Some Integration",
    }
    state.name = "Some Integration"
    return state


def test_ai_task_failure_does_not_mark_version_as_notified():
    hass = MagicMock()
    hass.state = "not_running"
    hass.services.async_call = AsyncMock(side_effect=RuntimeError("AI Task unavailable"))

    entry = MagicMock()
    entry.entry_id = "entry1"
    entry.data = {}
    entry.options = {
        "alert_mode_only": True,
        "ai_task_entity": "ai_task.gemini",
        "language": "en",
    }

    registered = {}

    def _capture_listener(event_type, callback):
        registered[event_type] = callback

    hass.bus.async_listen.side_effect = _capture_listener

    with patch(
        "homeassistant.helpers.storage.Store.async_load",
        AsyncMock(return_value={}),
    ), patch(
        "homeassistant.helpers.storage.Store.async_save", AsyncMock()
    ) as mock_save, patch(
        "custom_components.changelog_traduction._fetch_github_release_body",
        AsyncMock(return_value="Some changelog text"),
    ):
        run(async_setup_entry(hass, entry))

        handler = registered[EVENT_STATE_CHANGED]
        event = MagicMock()
        event.data = {
            "entity_id": "update.some_integration",
            "new_state": _make_state(),
        }
        run(handler(event))

        mock_save.assert_not_called()

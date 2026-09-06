"""Unit tests for the two config/options flow validation branches.

Instantiates the flow classes directly and overrides async_show_form /
async_create_entry with plain capturing stand-ins, rather than going
through Home Assistant's real FlowManager (which needs a live hass and
would fail on attributes like self.flow_id that only the manager
normally assigns) - this exercises exactly the validation logic in
async_step_user/async_step_init without needing real HA flow plumbing.
Same no-fixture philosophy as the rest of this repo's tests (see
conftest.py and .github/workflows/tests.yml).
"""
import asyncio
from unittest.mock import MagicMock

from custom_components.changelog_traduction.config_flow import (
    ChangelogTraductionConfigFlow,
    ChangelogTraductionOptionsFlow,
)


def run(coro):
    return asyncio.run(coro)


def _make_hass(has_ai_task=True):
    hass = MagicMock()
    hass.states.async_entity_ids = MagicMock(
        side_effect=lambda domain=None: (
            ["ai_task.gemini"] if (has_ai_task and domain == "ai_task") else []
        )
    )
    hass.config.language = "fr"
    return hass


def _make_flow(hass):
    flow = ChangelogTraductionConfigFlow()
    flow.hass = hass
    calls = {}

    def fake_show_form(*, step_id, data_schema, errors=None):
        calls["show_form"] = {"step_id": step_id, "errors": errors}
        return calls["show_form"]

    def fake_create_entry(*, title=None, data=None):
        calls["create_entry"] = {"title": title, "data": data}
        return calls["create_entry"]

    flow.async_show_form = fake_show_form
    flow.async_create_entry = fake_create_entry
    return flow, calls


def test_step_user_first_call_shows_empty_form():
    hass = _make_hass()
    flow, calls = _make_flow(hass)

    run(flow.async_step_user(None))

    assert calls["show_form"]["errors"] == {}
    assert "create_entry" not in calls


def test_step_user_requires_ai_task_entity():
    hass = _make_hass(has_ai_task=False)
    flow, calls = _make_flow(hass)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": True,
        "use_mobile_notification": True,
    }

    run(flow.async_step_user(user_input))

    assert calls["show_form"]["errors"] == {"base": "no_ai_task_entity"}
    assert "create_entry" not in calls


def test_step_user_requires_at_least_one_notification_channel():
    hass = _make_hass(has_ai_task=True)
    flow, calls = _make_flow(hass)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": False,
        "use_mobile_notification": False,
    }

    run(flow.async_step_user(user_input))

    assert calls["show_form"]["errors"] == {"base": "no_notification_channel"}
    assert "create_entry" not in calls


def test_step_user_creates_entry_when_valid():
    hass = _make_hass(has_ai_task=True)
    flow, calls = _make_flow(hass)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": True,
        "use_mobile_notification": False,
    }

    run(flow.async_step_user(user_input))

    assert calls["create_entry"] == {"title": "Changelog Traduction", "data": user_input}
    assert "show_form" not in calls


def test_step_user_accepts_mobile_only_notification():
    hass = _make_hass(has_ai_task=True)
    flow, calls = _make_flow(hass)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": False,
        "use_mobile_notification": True,
    }

    run(flow.async_step_user(user_input))

    assert "create_entry" in calls


class _FakeConfigEntry:
    def __init__(self, data=None, options=None):
        self.data = data or {}
        self.options = options or {}


def _make_options_flow(hass, config_entry):
    flow = ChangelogTraductionOptionsFlow()
    flow.hass = hass
    # Recent Home Assistant versions expose OptionsFlow.config_entry as a
    # read-only property (self.hass.config_entries.async_get_entry(self.handler))
    # rather than a plain settable attribute - so config_entry is injected by
    # setting flow.handler and mocking hass.config_entries.async_get_entry to
    # return our fake entry, instead of assigning flow.config_entry directly.
    flow.handler = "test_entry_id"
    hass.config_entries.async_get_entry = MagicMock(return_value=config_entry)
    calls = {}

    def fake_show_form(*, step_id, data_schema, errors=None):
        calls["show_form"] = {"step_id": step_id, "errors": errors}
        return calls["show_form"]

    def fake_create_entry(*, data=None):
        calls["create_entry"] = {"data": data}
        return calls["create_entry"]

    flow.async_show_form = fake_show_form
    flow.async_create_entry = fake_create_entry
    return flow, calls


def test_options_flow_first_call_shows_form_with_no_errors():
    hass = _make_hass()
    entry = _FakeConfigEntry(
        data={"notify_service": ["notify.iphone_fred"], "ai_task_entity": "ai_task.gemini"},
        options={"alert_mode_only": True},
    )
    flow, calls = _make_options_flow(hass, entry)

    run(flow.async_step_init(None))

    assert calls["show_form"]["errors"] == {}


def test_options_flow_requires_notification_channel():
    hass = _make_hass(has_ai_task=True)
    entry = _FakeConfigEntry(
        data={"notify_service": ["notify.iphone_fred"], "ai_task_entity": "ai_task.gemini"}
    )
    flow, calls = _make_options_flow(hass, entry)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": False,
        "use_mobile_notification": False,
    }

    run(flow.async_step_init(user_input))

    assert calls["show_form"]["errors"] == {"base": "no_notification_channel"}


def test_options_flow_saves_when_valid():
    hass = _make_hass(has_ai_task=True)
    entry = _FakeConfigEntry(
        data={"notify_service": ["notify.iphone_fred"], "ai_task_entity": "ai_task.gemini"}
    )
    flow, calls = _make_options_flow(hass, entry)
    user_input = {
        "notify_service": ["notify.iphone_fred"],
        "ai_task_entity": "ai_task.gemini",
        "use_persistent_notification": True,
        "use_mobile_notification": True,
        "alert_mode_only": True,
    }

    run(flow.async_step_init(user_input))

    assert calls["create_entry"] == {"data": user_input}

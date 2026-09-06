"""Unit tests for _deliver(), the notification-delivery function.

No pytest-homeassistant-custom-component fixtures exist in this repo (see
conftest.py - a bare sys.path shim - and .github/workflows/tests.yml,
which only installs plain `homeassistant` + `pytest`, no async plugin).
So async code is tested via plain asyncio.run() rather than
@pytest.mark.asyncio, and hass is a lightweight MagicMock exposing only
hass.services.async_call, which is all _deliver actually touches.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from custom_components.changelog_traduction import DOMAIN, _deliver


def run(coro):
    return asyncio.run(coro)


def _make_hass():
    hass = MagicMock()
    hass.services.async_call = AsyncMock()
    return hass


def test_persistent_notification_id_is_keyed_by_entity_id():
    # Regression test for the notification_id collision bug: two different
    # update.* entities that happen to share the same displayed title must
    # not collide and overwrite each other's persistent notification - the
    # id has to be derived from entity_id (always unique), not title.
    hass = _make_hass()
    options = {"use_persistent_notification": True, "use_mobile_notification": False}

    delivered = run(_deliver(hass, options, "update.integration_a", "My Integration", "msg", "en"))

    assert delivered is True
    hass.services.async_call.assert_awaited_once_with(
        "persistent_notification",
        "create",
        {
            "title": "Update: My Integration",
            "message": "msg",
            "notification_id": f"{DOMAIN}_update.integration_a",
        },
    )


def test_two_entities_with_same_title_get_different_notification_ids():
    hass = _make_hass()
    options = {"use_persistent_notification": True, "use_mobile_notification": False}

    run(_deliver(hass, options, "update.integration_a", "My Integration", "msg", "en"))
    call_a = hass.services.async_call.call_args
    hass.services.async_call.reset_mock()
    run(_deliver(hass, options, "update.integration_b", "My Integration", "msg", "en"))
    call_b = hass.services.async_call.call_args

    assert call_a.args[2]["notification_id"] != call_b.args[2]["notification_id"]


def test_mobile_notification_normalizes_bare_string_target_to_list():
    hass = _make_hass()
    options = {
        "use_persistent_notification": False,
        "use_mobile_notification": True,
        "notify_service": "notify.iphone_fred",
    }

    delivered = run(_deliver(hass, options, "update.foo", "TF1", "msg", "en"))

    assert delivered is True
    hass.services.async_call.assert_awaited_once_with(
        "notify",
        "send_message",
        {"title": "Update: TF1", "message": "msg"},
        target={"entity_id": ["notify.iphone_fred"]},
    )


def test_mobile_notification_skipped_when_no_notify_service_configured():
    hass = _make_hass()
    options = {"use_persistent_notification": False, "use_mobile_notification": True}

    delivered = run(_deliver(hass, options, "update.foo", "TF1", "msg", "en"))

    assert delivered is False
    hass.services.async_call.assert_not_awaited()


def test_returns_false_when_both_channels_disabled():
    hass = _make_hass()
    options = {"use_persistent_notification": False, "use_mobile_notification": False}

    delivered = run(_deliver(hass, options, "update.foo", "TF1", "msg", "en"))

    assert delivered is False
    hass.services.async_call.assert_not_awaited()


def test_one_failing_channel_does_not_undo_a_succeeding_one():
    # Regression guard: delivered must stay True once any channel has
    # succeeded - a later channel raising must not flip it back to False.
    hass = _make_hass()
    hass.services.async_call = AsyncMock(side_effect=[None, Exception("boom")])
    options = {
        "use_persistent_notification": True,
        "use_mobile_notification": True,
        "notify_service": ["notify.iphone_fred"],
    }

    delivered = run(_deliver(hass, options, "update.foo", "TF1", "msg", "en"))

    assert delivered is True
    assert hass.services.async_call.await_count == 2


def test_persistent_notification_exception_is_swallowed_not_raised():
    hass = _make_hass()
    hass.services.async_call = AsyncMock(side_effect=Exception("boom"))
    options = {"use_persistent_notification": True, "use_mobile_notification": False}

    delivered = run(_deliver(hass, options, "update.foo", "TF1", "msg", "en"))

    assert delivered is False

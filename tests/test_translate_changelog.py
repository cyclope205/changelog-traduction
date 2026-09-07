"""Unit tests for _translate_changelog()'s alert-mode breaking-change
classification, focused on the AI-failure sentinel distinction.

Regression coverage for the bug where an AI Task exception during
alert-mode classification was indistinguishable from "AI confirmed this
release is not breaking" - both returned plain None, so _process_state
permanently marked the version as seen even though it was never actually
classified. _translate_changelog now returns the _AI_CLASSIFICATION_UNKNOWN
sentinel on failure instead, so the version can be safely re-evaluated
later without ever having sent a false-positive "not breaking" verdict.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from custom_components.changelog_traduction import (
    _AI_CLASSIFICATION_UNKNOWN,
    _translate_changelog,
)


def run(coro):
    return asyncio.run(coro)


def _make_hass(*, side_effect=None, return_value=None):
    hass = MagicMock()
    hass.services.async_call = AsyncMock(side_effect=side_effect, return_value=return_value)
    return hass


def _alert_mode_options():
    return {"alert_mode_only": True, "ai_task_entity": "ai_task.gemini"}


def test_alert_mode_ai_task_exception_returns_unknown_sentinel():
    hass = _make_hass(side_effect=RuntimeError("AI Task unavailable"))
    result = run(
        _translate_changelog(
            hass, _alert_mode_options(), "Some Integration", "some changelog text", "en"
        )
    )
    assert result is _AI_CLASSIFICATION_UNKNOWN
    assert result is not None


def test_unknown_sentinel_is_not_none_and_is_truthy():
    # The whole point of the sentinel: callers must be able to tell
    # "classification failed" apart from "classification succeeded, not
    # breaking" using `is`, not equality/truthiness.
    assert _AI_CLASSIFICATION_UNKNOWN is not None
    assert bool(_AI_CLASSIFICATION_UNKNOWN) is True


def test_alert_mode_ai_confirms_not_breaking_returns_none():
    hass = _make_hass(return_value={"data": {"has_breaking_changes": False}})
    result = run(
        _translate_changelog(
            hass, _alert_mode_options(), "Some Integration", "some changelog text", "en"
        )
    )
    assert result is None


def test_alert_mode_ai_confirms_breaking_returns_summary():
    hass = _make_hass(
        return_value={
            "data": {"has_breaking_changes": True, "summary": "Removed the foo service."}
        }
    )
    result = run(
        _translate_changelog(
            hass, _alert_mode_options(), "Some Integration", "some changelog text", "en"
        )
    )
    assert result == "Removed the foo service."


def test_alert_mode_malformed_ai_response_returns_none_not_unknown():
    # A response that comes back successfully but without the expected
    # shape (e.g. "data" missing/wrong type) is treated the same as "not
    # breaking", matching existing behavior - only an actual exception
    # should produce the UNKNOWN sentinel.
    hass = _make_hass(return_value={"data": None})
    result = run(
        _translate_changelog(
            hass, _alert_mode_options(), "Some Integration", "some changelog text", "en"
        )
    )
    assert result is None

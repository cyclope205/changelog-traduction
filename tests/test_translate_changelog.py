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
    _format_categorized_message,
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


def test_normal_mode_ai_empty_response_uses_translation_failed_fallback():
    # An empty/falsy AI response means the AI Task call succeeded but
    # produced nothing usable - this must NOT be reported as "no
    # changelog" (a source was found and sent to the AI; it's the AI
    # that failed to produce output), so it should use the same wording
    # as an actual AI Task exception.
    hass = _make_hass(return_value={"data": ""})
    result = run(
        _translate_changelog(
            hass, {"ai_task_entity": "ai_task.gemini"}, "Some Integration",
            "some changelog text", "en",
        )
    )
    assert result == "Some Integration: update available (automatic translation failed)."


def test_alert_mode_breaking_with_empty_summary_uses_translation_failed_fallback():
    # has_breaking_changes=True but an empty summary means the AI
    # confirmed a breaking change yet failed to produce the actual text -
    # same "translation_failed" wording applies here too, not
    # "no_changelog" (the release notes were found and were breaking).
    hass = _make_hass(
        return_value={"data": {"has_breaking_changes": True, "summary": ""}}
    )
    result = run(
        _translate_changelog(
            hass, _alert_mode_options(), "Some Integration", "some changelog text", "en"
        )
    )
    assert result == "Some Integration: update available (automatic translation failed)."



# ---------------------------------------------------------------------------
# _format_categorized_message: pure rendering of the three AI-categorized
# bullet lists into the notification body (no I/O, no hass instance).
# ---------------------------------------------------------------------------

def test_format_categorized_message_all_sections_populated():
    message = _format_categorized_message(
        "en",
        ["Added a genre filter."],
        ["Fixed the TV guide failing to load."],
        ["Renamed the 'channels' option to 'tracked_channels'."],
    )
    assert "🆕 New" in message
    assert "• Added a genre filter." in message
    assert "🔧 Fixed" in message
    assert "• Fixed the TV guide failing to load." in message
    assert "⚠️ Breaking changes" in message
    assert "• Renamed the 'channels' option to 'tracked_channels'." in message
    # New features come first, then fixes, then breaking changes - matches
    # the order a changelog reader expects (what's new, what's fixed, what
    # might break your setup, roughly ascending severity).
    assert message.index("🆕 New") < message.index("🔧 Fixed") < message.index(
        "⚠️ Breaking changes"
    )


def test_format_categorized_message_empty_categories_use_none_placeholder():
    message = _format_categorized_message("en", [], [], [])
    # All three headers still appear even though every list is empty - the
    # reader should see all three sections and judge for themselves that
    # nothing changed, not wonder whether a missing section means "empty"
    # or "not checked".
    assert "🆕 New\n• None" in message
    assert "🔧 Fixed\n• None" in message
    assert "⚠️ Breaking changes\n• None" in message


def test_format_categorized_message_french_labels_and_placeholder():
    message = _format_categorized_message("fr", ["Nouveau filtre genre."], [], [])
    assert "🆕 Nouveautés" in message
    assert "• Nouveau filtre genre." in message
    assert "🔧 Corrections\n• Aucune" in message
    assert "⚠️ Breaking changes\n• Aucune" in message


def test_format_categorized_message_unknown_language_falls_back_to_english():
    message = _format_categorized_message("ja", [], [], [])
    # No hand-written Japanese labels exist - falls back to the English
    # set entirely, matching FALLBACK_STRINGS's own fallback behavior.
    assert "🆕 New\n• None" in message


def test_format_categorized_message_includes_version_line_when_provided():
    message = _format_categorized_message(
        "en", ["A feature."], [], [], version_line="2.4.0 → 2.5.0"
    )
    assert message.startswith("2.4.0 → 2.5.0\n\n🆕 New")


def test_format_categorized_message_omits_version_line_when_none():
    message = _format_categorized_message("en", ["A feature."], [], [])
    assert message.startswith("🆕 New")
    assert "→" not in message


# ---------------------------------------------------------------------------
# _translate_changelog: normal-mode (non-alert) structured categorization.
# ---------------------------------------------------------------------------

def _normal_mode_options():
    return {"ai_task_entity": "ai_task.gemini"}


def test_normal_mode_categorizes_ai_response_into_sections():
    hass = _make_hass(
        return_value={
            "data": {
                "new_features": ["Added a genre filter."],
                "fixes": ["Fixed the TV guide failing to load."],
                "breaking_changes": [],
            }
        }
    )
    result = run(
        _translate_changelog(
            hass, _normal_mode_options(), "Some Integration",
            "some changelog text", "en",
        )
    )
    assert "🆕 New\n• Added a genre filter." in result
    assert "🔧 Fixed\n• Fixed the TV guide failing to load." in result
    assert "⚠️ Breaking changes\n• None" in result


def test_normal_mode_all_empty_categories_is_not_translation_failed():
    # A well-formed structured response where every list is legitimately
    # empty (e.g. a release that's purely internal refactoring/CI) is a
    # real result, not a failure - must NOT fall back to the "translation
    # failed" wording, unlike a response that isn't a dict at all (see
    # test_normal_mode_ai_empty_response_uses_translation_failed_fallback
    # above, which covers that other case).
    hass = _make_hass(
        return_value={"data": {"new_features": [], "fixes": [], "breaking_changes": []}}
    )
    result = run(
        _translate_changelog(
            hass, _normal_mode_options(), "Some Integration",
            "some changelog text", "en",
        )
    )
    assert "failed" not in result.lower()
    assert "🆕 New\n• None" in result
    assert "🔧 Fixed\n• None" in result
    assert "⚠️ Breaking changes\n• None" in result


def test_normal_mode_passes_structure_and_version_line_to_ai_task():
    hass = _make_hass(
        return_value={
            "data": {"new_features": ["X"], "fixes": [], "breaking_changes": []}
        }
    )
    result = run(
        _translate_changelog(
            hass, _normal_mode_options(), "Some Integration",
            "some changelog text", "en", version_line="1.0 → 2.0",
        )
    )
    assert result.startswith("1.0 → 2.0\n\n🆕 New")
    call_kwargs = hass.services.async_call.call_args
    domain, service, payload = call_kwargs.args[0], call_kwargs.args[1], call_kwargs.args[2]
    assert (domain, service) == ("ai_task", "generate_data")
    assert set(payload["structure"].keys()) == {"new_features", "fixes", "breaking_changes"}
    assert payload["entity_id"] == "ai_task.gemini"


def test_normal_mode_ai_task_exception_uses_translation_failed_fallback():
    # Normal mode has no UNKNOWN-sentinel concept (that's alert-mode-only,
    # since only alert mode's "mark as seen" decision depends on telling
    # a failure apart from a confirmed non-breaking release) - an
    # exception here just falls back to the existing wording, same as
    # before this change.
    hass = _make_hass(side_effect=RuntimeError("AI Task unavailable"))
    result = run(
        _translate_changelog(
            hass, _normal_mode_options(), "Some Integration",
            "some changelog text", "en",
        )
    )
    assert result == "Some Integration: update available (automatic translation failed)."

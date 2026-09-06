"""Unit tests for the _fallback() hand-written fallback strings.

_fallback is the only plain, synchronous, module-level function in
__init__.py with no Home Assistant runtime dependency - everything else is
either a nested closure inside async_setup_entry (not importable on its
own) or does real I/O (GitHub/Supervisor/AI Task calls). Same "pure logic,
no I/O" philosophy as programme-tnt-fr's test_coordinator.py.
"""
from custom_components.changelog_traduction import FALLBACK_STRINGS, _fallback


def test_fallback_returns_french_string():
    result = _fallback("fr", "notif_title", title="TF1")
    assert result == "Mise à jour : TF1"


def test_fallback_returns_english_string():
    result = _fallback("en", "notif_title", title="TF1")
    assert result == "Update: TF1"


def test_fallback_falls_back_to_english_for_unsupported_language():
    # "it" (Italian) has no hand-written fallback strings - README "Known
    # limitations" says this should silently default to English rather
    # than raising or mixing languages.
    result = _fallback("it", "notif_title", title="TF1")
    assert result == _fallback("en", "notif_title", title="TF1")


def test_fallback_formats_all_kwargs():
    result = _fallback("fr", "no_changelog", title="TF1", version=" v2.0")
    assert result == (
        "Mise à jour disponible pour TF1 v2.0 — notes de version non "
        "disponibles pour cette source."
    )


def test_fallback_strings_cover_the_same_keys_in_every_language():
    # A language dict missing a key that _fallback is actually called with
    # would raise a KeyError in production - guard against silent drift
    # between languages as new keys get added over time.
    key_sets = {lang: set(strings.keys()) for lang, strings in FALLBACK_STRINGS.items()}
    reference = key_sets["en"]
    for lang, keys in key_sets.items():
        assert keys == reference, f"{lang} fallback keys differ from en: {keys ^ reference}"

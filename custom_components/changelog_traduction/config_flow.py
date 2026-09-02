"""Config flow for Changelog Traduction."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers import selector

from .const import DOMAIN


class ChangelogTraductionConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Changelog Traduction."""

    VERSION = 1

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> ChangelogTraductionOptionsFlow:
        """Expose the options flow so settings can be revisited without
        deleting and re-adding the integration (see README "Known
        limitations")."""
        return ChangelogTraductionOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Single-step setup: pick delivery options and target language."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # An ai_task entity is required for translation to actually work -
            # without one (e.g. Google Generative AI, or another AI Task
            # provider, installed and configured), every changelog would
            # silently fall back to the untranslated placeholder message.
            if not self.hass.states.async_entity_ids("ai_task"):
                errors["base"] = "no_ai_task_entity"
            else:
                return self.async_create_entry(title="Changelog Traduction", data=user_input)

        schema = vol.Schema(
            {
                # No hardcoded default here on purpose: a pre-filled entity
                # that only exists on one specific installation (e.g. one
                # person's phone) would silently fail for anyone else who
                # accepts the default without noticing.
                vol.Required("notify_service"): selector.selector(
                    {"entity": {"filter": [{"domain": "notify"}], "multiple": True}}
                ),
                vol.Required("ai_task_entity"): selector.selector(
                    {"entity": {"filter": [{"domain": "ai_task"}]}}
                ),
                # IMPORTANT: default explicitly to hass.config.language (the
                # SYSTEM's configured interface language) rather than leaving
                # this selector unset. A bare vol.Optional with no default
                # lets the frontend LanguageSelector pre-fill itself with
                # whatever language is currently displayed to the person
                # filling the form - which can be their own profile/browser
                # language, NOT hass.config.language, and silently submits
                # that if they don't touch the field. Setting the default
                # here explicitly is what actually makes "leave it alone"
                # mean "use Home Assistant's configured language".
                vol.Optional(
                    "language", default=self.hass.config.language
                ): selector.selector({"language": {}}),
                vol.Optional("use_persistent_notification", default=True): bool,
                vol.Optional("use_mobile_notification", default=True): bool,
                # "Alert mode": when on, the AI is asked to classify each
                # release as containing breaking changes or not, and only
                # deliver a notification when it does - see README "Des
                # options de filtrage par l'IA" for the rationale. Off by
                # default so existing behaviour (translate/summarize every
                # update) is unchanged unless explicitly opted into.
                vol.Optional("alert_mode_only", default=False): bool,
                # Per-entity exclude list: specific update.* entities that
                # should NEVER trigger a notification, no matter what alert
                # mode decides - e.g. Spook's Blueprint update trackers,
                # which only track a raw file hash and have no real release
                # notes to classify in the first place. Empty by default so
                # nothing is silenced unless explicitly opted into.
                vol.Optional("excluded_entities", default=[]): selector.selector(
                    {"entity": {"filter": [{"domain": "update"}], "multiple": True}}
                ),
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )


class ChangelogTraductionOptionsFlow(config_entries.OptionsFlow):
    """Let every setting picked at setup time be revisited later.

    Mirrors the initial config_flow schema exactly (same fields, same
    selectors), pre-filled with the entry's current values, so changing e.g.
    the notification target or the AI Task entity no longer requires
    deleting and re-adding the integration.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}
        # entry.options overrides entry.data field-by-field once the options
        # flow has been submitted at least once; before that, entry.data
        # (the original setup values) is all there is.
        current: dict[str, Any] = {
            **self.config_entry.data,
            **self.config_entry.options,
        }

        if user_input is not None:
            if not self.hass.states.async_entity_ids("ai_task"):
                errors["base"] = "no_ai_task_entity"
            else:
                return self.async_create_entry(data=user_input)

        schema = vol.Schema(
            {
                vol.Required(
                    "notify_service", default=current.get("notify_service")
                ): selector.selector(
                    {"entity": {"filter": [{"domain": "notify"}], "multiple": True}}
                ),
                vol.Required(
                    "ai_task_entity", default=current.get("ai_task_entity")
                ): selector.selector(
                    {"entity": {"filter": [{"domain": "ai_task"}]}}
                ),
                vol.Optional(
                    "language",
                    default=current.get("language", self.hass.config.language),
                ): selector.selector({"language": {}}),
                vol.Optional(
                    "use_persistent_notification",
                    default=current.get("use_persistent_notification", True),
                ): bool,
                vol.Optional(
                    "use_mobile_notification",
                    default=current.get("use_mobile_notification", True),
                ): bool,
                vol.Optional(
                    "alert_mode_only",
                    default=current.get("alert_mode_only", False),
                ): bool,
                vol.Optional(
                    "excluded_entities",
                    default=current.get("excluded_entities", []),
                ): selector.selector(
                    {"entity": {"filter": [{"domain": "update"}], "multiple": True}}
                ),
            }
        )
        return self.async_show_form(
            step_id="init", data_schema=schema, errors=errors
        )

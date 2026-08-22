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
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )

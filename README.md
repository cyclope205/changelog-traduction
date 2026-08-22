# Changelog Traduction

A Home Assistant custom integration that watches your `update.*` entities and, when an update becomes available, fetches its real release notes and has an AI Task entity translate/summarize them into your language — delivered as a persistent notification and/or a mobile push notification.

*[Français ci-dessous](#francais)*

---

## English

### What it does

- Watches every `update.*` entity (HACS integrations, Supervisor add-ons, Home Assistant Core/Supervisor/OS).
- Fetches the actual release notes, depending on the source:
  - **GitHub-hosted integrations (most HACS repos):** via the public GitHub Releases API.
    - **Supervisor add-ons:** via Supervisor's own changelog endpoint (the same one the HA frontend uses internally).
      - **Home Assistant Core:** its release-notes web page is fetched and handed to the AI, which extracts the relevant content itself.
        - If none of these yield anything, a plain "update available" notice is sent — never invented content.
        - Translates/summarizes the result with your configured AI Task entity (e.g. Google Generative AI), in **your** language — by default Home Assistant's own interface language (`hass.config.language`), or a language you pick explicitly in the config screen.
        - Sends the result as a persistent notification and/or a push notification to the device(s) you choose.
        - Notifies once per version (tracked internally), so no repeat spam on every HA restart.

        ### Requirements

        - An **AI Task** entity already configured (e.g. Google Generative AI, or any other AI Task provider).
        - [HACS](https://hacs.xyz) installed (recommended), or manual installation.

        ### Installation

        **Via HACS (custom repository):**
        1. HACS → ⋮ menu → Custom repositories → add this repository's URL, category "Integration".
        2. Install "Changelog Traduction", restart Home Assistant.
        3. Settings → Devices & services → Add integration → search "Changelog Traduction".
        4. Pick one or more notification entities and your AI Task entity. Leave the language field alone to follow Home Assistant's interface language, or set one explicitly.

        **Manual installation:**
        1. Copy the `custom_components/changelog_traduction/` folder into your `config/custom_components/` directory.
        2. Restart Home Assistant (a full restart — reloading the integration alone won't pick up new files).
        3. Add the integration as above.

        ### Known limitations

        - Add-on changelog access relies on an internal, undocumented part of the `hassio` integration — if a future HA release changes it, this simply falls back to the generic message, without breaking anything else.
        - Home Assistant Core's release notes come from a general web page (not a per-version API), so extraction quality depends on the AI correctly ignoring navigation/footer noise.
        - The public GitHub API is rate-limited to 60 requests/hour without authentication.
        - Only a handful of languages have hand-written fallback strings (used only when translation itself fails); everything else defaults to English for those specific strings. The AI-generated translations themselves work in any language you configure.
        - Single config entry only; no reconfigure screen yet — change settings by removing and re-adding the integration.

        ### License

        See [LICENSE](LICENSE).

        ---

        ## Francais

        ### Ce que ca fait

        - Surveille toutes les entites `update.*` (integrations HACS, add-ons Supervisor, Home Assistant Core/Supervisor/OS).
        - Recupere les vraies notes de version, selon la source :
          - **Integrations hebergees sur GitHub (la plupart des depots HACS) :** via l'API publique GitHub Releases.
            - **Add-ons Supervisor :** via le point d'acces changelog interne de Supervisor (le meme qu'utilise l'interface HA).
              - **Home Assistant Core :** sa page web de notes de version est recuperee puis confiee a l'IA, qui en extrait elle-meme le contenu pertinent.
                - Si aucune de ces sources ne donne de resultat, un simple message "mise a jour disponible" est envoye — jamais de contenu invente.
                - Traduit/resume le resultat via ton entite AI Task configuree (ex : Google Generative AI), dans **ta** langue — par defaut celle de l'interface Home Assistant (`hass.config.language`), ou une langue choisie explicitement dans l'ecran de configuration.
                - Envoie le resultat en notification persistante et/ou notification push vers le ou les appareils de ton choix.
                - Ne notifie qu'une fois par version (suivi en interne), donc pas de spam a chaque redemarrage de HA.

                ### Prerequis

                - Une entite **AI Task** deja configuree (ex : Google Generative AI, ou tout autre fournisseur AI Task).
                - [HACS](https://hacs.xyz) installe (recommande), ou installation manuelle.

                ### Installation

                **Via HACS (depot personnalise) :**
                1. HACS → menu ⋮ → Depots personnalises → ajoute l'URL de ce depot, categorie "Integration".
                2. Installe "Changelog Traduction", redemarre Home Assistant.
                3. Parametres → Appareils et services → Ajouter une integration → cherche "Changelog Traduction".
                4. Choisis un ou plusieurs appareils de notification et ton entite AI Task. Laisse le champ langue tel quel pour suivre la langue de l'interface HA, ou fixe-en une explicitement.

                **Installation manuelle :**
                1. Copie le dossier `custom_components/changelog_traduction/` dans ton dossier `config/custom_components/`.
                2. Redemarre completement Home Assistant (un simple rechargement de l'integration ne suffit pas pour prendre en compte de nouveaux fichiers).
                3. Ajoute l'integration comme ci-dessus.

                ### Limites connues

                - L'acces aux changelogs des add-ons repose sur une partie interne et non documentee de l'integration `hassio` — si une future version de HA la change, ca retombe simplement sur le message generique, sans casser le reste.
                - Les notes de version de Home Assistant Core viennent d'une page web generale (pas d'une API par version), donc la qualite de l'extraction depend de la capacite de l'IA a ignorer le bruit de navigation/pied de page.
                - L'API GitHub publique est limitee a 60 requetes/heure sans authentification.
                - Seules quelques langues ont des messages de repli ecrits a la main (utilises uniquement si la traduction elle-meme echoue) ; les autres langues utilisent l'anglais par defaut pour ces messages precis. Les traductions generees par l'IA, elles, fonctionnent dans n'importe quelle langue configuree.
                - Une seule instance a la fois, pas encore d'ecran de reconfiguration — pour changer les reglages, il faut supprimer puis reajouter l'integration.

                ### Licence

                Voir [LICENSE](LICENSE).
                

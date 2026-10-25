# Exemple : une application hôte qui embarque l'assistant QA-CRAWLER

« Acme Portail » est une application fictive. Elle pose `<qa-crawler-project-wizard mode="embedded">`
dans sa page, avec son propre thème (variables CSS publiques), et reçoit les événements de l'assistant.

```bash
npm run build                      # compile @qa-crawler/core, SDK compris
node examples/sdk-host/host.mjs    # SDK sur :4310, hôte sur :4320
```

Puis ouvrir `http://127.0.0.1:4320`.

Ce que l'exemple montre :

- **deux origines** : l'hôte (`:4320`) appelle l'API du serveur SDK (`:4310`), qui n'accepte que les
  origines listées (`allowedOrigins`) ;
- **le jeton** n'est jamais écrit dans la page : le back-end de l'hôte le remet à sa propre page
  (`/host-api/qa-crawler-token`), après avoir vérifié sa session utilisateur ;
- **le thème** : `--qa-color-primary`, `--qa-radius`, `--qa-font-family` posés sur l'élément ;
- **les événements** : `qa-project-created`, `qa-exploration-started`, `qa-exploration-completed`,
  `qa-exploration-failed`.

Les projets créés sont écrits dans `examples/sdk-host/.workspace/` (ignoré par git). Voir
[docs/sdk/README.md](../../docs/sdk/README.md) pour l'API complète.

# Exemple : une application hôte qui embarque les composants QA-CRAWLER

« Acme Portail » est une application fictive. Elle pose les quatre composants du SDK dans ses
propres pages, avec son thème (variables CSS publiques), un seul jeton et un seul réglage clair/sombre :

| Section        | Élément                                       | Branché sur                              |
| -------------- | --------------------------------------------- | ---------------------------------------- |
| Nouveau projet | `<qa-crawler-project-wizard mode="embedded">` | —                                        |
| Suivi          | `<qa-crawler-run-monitor>`                    | l'exploration lancée par l'assistant     |
| Comparaison    | `<qa-crawler-run-compare>`                    | les explorations du projet créé          |
| Studio         | `<qa-crawler-flow-studio>`                    | un enregistrement du projet, par son nom |

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
- **le thème** : `--qa-color-primary`, `--qa-radius`, `--qa-font-family` posés sur les éléments, et
  `theme="auto|light|dark"` réglé une fois pour les quatre ;
- **les événements** : `qa-project-created` (la comparaison et le Studio prennent le projet),
  `qa-exploration-started` (le suivi prend l'exploration), `qa-exploration-completed` (la comparaison
  se recharge), `qa-exploration-failed`, `qa-monitor-connection`.

Les projets créés sont écrits dans `examples/sdk-host/.workspace/` (ignoré par git). Voir
[docs/sdk/README.md](../../docs/sdk/README.md) pour l'API complète.

# Risques d'anomalies

Moteur déterministe qui signale, avant toute erreur observée, les endroits où le code peut produire une
anomalie. Il n'appelle aucun LLM et n'exécute aucun code de l'application.

## Chaîne

1. **Faits** (`src/cartography/analyze-risk.ts`), produits au scan pour chaque source et gardés avec elle
   (une source inchangée reprend ses faits) :
   - **TypeScript / Angular** : détenteurs d'état (Subject, BehaviorSubject, signal, champ de service) avec
     leur portée (racine, fournie, composant) et leur persistance ; écritures (valeur, remise à zéro, mutation
     en place) et leur contexte (synchrone, suite, erreur, finalize…) ; souscriptions (libération, gestion
     d'erreur, imbrication) ; indicateurs de chargement ; ressources (écouteurs, intervalles) ; pipes
     (aplatissement, `catchError` interne ou externe) ; onglets.
   - **Java / Spring** : champs mutables de singleton, exceptions avalées, écritures multiples sans
     `@Transactional`.
2. **Règles** (`src/risk/rules.ts`) : chaque règle déclare ses prérequis et ses limites. Une règle qui conclut
   sur une absence (« aucune remise à zéro ») ne devient pas affirmative sur une source partiellement lue.
3. **Impact** (`src/risk/impact.ts`) : parcours borné du graphe de la cartographie (profondeur 5, 40 nœuds,
   mémoïsé, sans cycle). Il ne suit que les liens qui propagent une donnée ; un lien d'erreur arrête la
   propagation. Une fonctionnalité n'est impactée que par un composant consommateur, jamais par l'écrivain.
4. **Rapport** (`src/risk/engine.ts`) : identifiant stable, empreinte, diff avec le scan précédent,
   suppressions, vérifications, tri par sévérité puis confiance, et métriques mesurées (durée, fichiers,
   règles, nœuds parcourus).

## Statuts et confiance

| Statut       | Signification                                                                      |
| ------------ | ---------------------------------------------------------------------------------- |
| POTENTIAL    | Motif reconnu, peu de preuves                                                      |
| CORROBORATED | Preuves concordantes (chemin démontré, simulation)                                 |
| REPRODUCED   | Un test exécuté dans le projet l'a montré (déclaré)                                |
| REFUTED      | Une vérification l'a contredit                                                     |
| INCONCLUSIVE | Une inconnue bloque : détenteur public, source partielle, lien seulement incertain |

La confiance est calculée indépendamment de la sévérité :

- point de départ de 0,15 ;
- chaque preuve qui soutient ajoute 0,20, 0,12 ou 0,06 selon sa fiabilité ;
- chaque contre-indice retire 0,25, 0,15 ou 0,08 ;
- chaque inconnue retire 0,10, dans la limite de 0,30 ;
- un chemin démontré jusqu'au consommateur ajoute 0,10.

Le résultat est borné entre 0,05 et 0,90. Seule une reproduction dépasse 0,90 ; une réfutation ramène la
confiance à 0,10 au plus. Le détail du calcul est affiché avec chaque risque.

## Vérification

- **Simulation des transitions** : elle rejoue le scénario sur les faits. Elle corrobore ou réfute un risque,
  mais ne le reproduit jamais. Pour un état conservé, sans attendu métier déclaré, le résultat reste
  inconclusif (la persistance peut être voulue).
- **Test du projet (déclaré)** : la personne qui a exécuté un test indique son résultat et ce qu'elle a
  observé. C'est la seule voie vers REPRODUCED. Le moteur n'exécute ni Playwright ni Cypress, ni le code de
  l'application.
- Une vérification dont l'empreinte ne correspond plus au code est marquée périmée.

## API (`/api/projects/:id/cartography`)

| Méthode | Route                         | Droit  |
| ------- | ----------------------------- | ------ |
| GET     | `/risks` (critères + résumé)  | VIEW   |
| GET     | `/risks/:id`                  | VIEW   |
| GET     | `/risks/:id/impact?depth=`    | VIEW   |
| GET     | `/risks/:id/evidence`         | VIEW   |
| GET     | `/risks/:id/verifications`    | VIEW   |
| POST    | `/risks/:id/verify`           | RUN    |
| POST    | `/risks/:id/suppress`         | DECIDE |
| POST    | `/risks/rules` (`{disabled}`) | DECIDE |

Persistance :

- `cartography/risks/<scanId>.json` contient un rapport par scan conservé ;
- `cartography/risk-state.json` contient les règles désactivées, les suppressions et les vérifications
  déclarées.

## Limites connues

- Règles non implémentées : RISK-STATE-004 et RISK-ASYNC-005.
- La corrélation d'un risque backend avec le front passe uniquement par la portée des fonctionnalités : il
  n'y a pas de chaîne Angular → BFF → Backend propre aux risques.
- La simulation porte sur les faits statiques et ne remplace pas un test du projet.

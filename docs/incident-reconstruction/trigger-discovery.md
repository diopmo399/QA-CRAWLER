# Découverte autonome des déclencheurs (`src/incident/trigger`)

La découverte des déclencheurs complète Incident Reconstruction quand les **conditions** d'un incident sont
inconnues : on sait où (une zone fonctionnelle, un bouton) et quoi (une perte de réaction), pas comment. Le moteur
explore un **environnement de test**, perturbe un ou plusieurs facteurs par essai, juge chaque essai par un oracle,
rejoue ce qui reproduit, réduit la séquence, dérive les conditions, analyse la première défaillance et la perte de
données, puis propose des hypothèses et des vérifications. Rien n'est présumé (ni Zone.js, ni RxJS, ni un
intercepteur, ni un service partagé, ni la détection de changements) : la cause se déduit des observations.

## Principes

- **Preuves d'abord.** Chaque élément porte sa provenance : `USER_REPORTED` (la description), `AI_INFERRED`,
  `STATICALLY_RESOLVED` (le code), `RUNTIME_OBSERVED` (le navigateur), `EXPERIMENT_VERIFIED` (un rejouage). Une phrase
  de la personne n'est jamais présentée comme une observation du navigateur.
- **Déterministe par défaut.** Le moteur fonctionne sans IA. Quand un modèle est configuré (`ai.incidents.mode` autre
  que `DETERMINISTIC`), l'IA ne fait que proposer des séquences de facteurs (identifiants du catalogue), jouées et
  jugées comme les autres ; une erreur IA est une limite écrite dans le run, jamais un arrêt.
- **Aucune cause confirmée par le moteur seul.** Les hypothèses sont `PROPOSED` (origine `RULE`, confiance < 0,7) ;
  la règle déterministe de confirmation de l'incident (deux vérifications de nature différente) reste la seule voie ;
  un rejouage qui ne distingue pas les hypothèses concurrentes est marqué `NEUTRAL`.
- **Périmètre contrôlé.** La découverte du périmètre n'accorde aucun droit : chaque ressource (route, scénario,
  composant, service, API, dépôt) porte `DISCOVERED`, `PROPOSED`, `AUTHORIZED`, `DENIED` ou `INACCESSIBLE` d'après le
  Scope Policy Engine ; la navigation vers la page d'entrée est elle-même vérifiée ; les boutons destructifs
  (supprimer, vider, payer…) ne sont jamais joués ; le contenu des pages, du code et des réponses est une donnée.
- **Rien d'invasif.** Aucune instrumentation n'est injectée dans l'application : les écouteurs Playwright (erreurs,
  console, requêtes, réponses, navigations, dialogues) sont posés avant la navigation ; les instantanés d'écran
  lisent les éléments accessibles (boutons, champs, onglets, superpositions, messages, indicateurs de chargement),
  valeurs masquées, champs sensibles jamais lus.

## Le parcours d'un run

| État                                                         | Ce qui se passe                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INITIALIZING`                                               | Budget résolu (par profondeur, plafonds), description interprétée (`interpretBrief`).                                                                                                                                       |
| `DISCOVERING_SCOPE`                                          | Dépôts, scénarios, modèle Angular (routes, composants, formulaires, services, API), hôtes : `ScopeGraph`.                                                                                                                   |
| `EXPLORING_TRIGGERS`                                         | Parcours de **référence** (navigation, remplissages valides, sondes : la réaction normale de chaque sonde), puis essais planifiés par les stratégies ; chaque essai est une nouvelle session de navigateur (même Chromium). |
| `FAILURE_DETECTED`                                           | L'oracle a rendu `FAILURE_REPRODUCED`.                                                                                                                                                                                      |
| `CONFIRMING_REPRODUCTION`                                    | La séquence est rejouée `repeats` fois : fréquence ; un bug intermittent est dit tel (corrélation, pas causalité).                                                                                                          |
| `MINIMIZING`                                                 | Delta debugging (`ddmin`) sur les facteurs, chaque candidat rejoué ; préconditions conservées ; « d'autres séquences minimales peuvent exister ».                                                                           |
| `ANALYZING_ROOT_CAUSE`                                       | Conditions (taux avec / sans ; `NECESSARY`, `CONTRIBUTING`, `CANDIDATE`, `REFUTED`), première défaillance, perte de données, hypothèses.                                                                                    |
| `VERIFYING_HYPOTHESES`                                       | Les vérifications sans effet de bord jouables par le navigateur (`CHECK_VALIDATION`, différentielle) sont jouées dans le budget.                                                                                            |
| `WAITING_FOR_APPROVAL`                                       | Des vérifications à effets de bord (`REPLAY`, `COMPARE_WITH_PASSING`) attendent une décision (`DECIDE`, `RUN_WRITES`).                                                                                                      |
| `PAUSED`, `CANCELLED`, `COMPLETED`, `INCONCLUSIVE`, `FAILED` | Pause et annulation coopératives (entre deux essais) ; rapport partiel toujours disponible.                                                                                                                                 |

Le run est persisté après chaque essai (`investigation.trigger.runs`, cinq runs conservés, événements bornés) :
`resume` repart du point de reprise sans rejouer les séquences déjà jouées, et peut élargir le budget.

## Stratégies (`strategies.ts`)

Jamais un produit cartésien complet. Par profondeur : `QUICK` = guidée (un facteur à la fois) + guidée par le
code ; `STANDARD` ajoute limites, guidée par l'erreur, paires ; `DEEP` ajoute séquences avec état, modèle, IA,
différentiel. La même séquence proposée par plusieurs stratégies garde la priorité la plus haute. La stratégie
**guidée par le code** lit le modèle Angular : un contrôle `Validators.required` désigne « vider ce champ » ; un
bouton dont le gestionnaire partage un service avec celui de la sonde désigne « ouvrir puis fermer ce dialogue » ;
les deux se combinent en paires. L'exécution tranche toujours.

Un essai = navigation + remplissages de référence (moins les champs que le facteur modifie) + actions des facteurs +
sondes : la sonde principale (bouton de soumission), une sonde indépendante (bouton d'actualisation), puis la sonde
principale à nouveau. Une perte de réaction se constate ainsi sur au moins deux sondes indépendantes.

## Oracle (`oracle.ts`)

Sept niveaux de réaction par sonde (`CLICKED` … `BUSINESS_RESULT`), chacun `OBSERVED`, `NOT_OBSERVED` ou
`UNOBSERVABLE`. Dix catégories de défaillance silencieuse. Règles : un message de validation visible explique à lui
seul l'absence d'envoi ; un indicateur de chargement déjà affiché, ou un changement de DOM pendant une erreur de
page, n'est pas une réaction ; `FAILURE_REPRODUCED` exige une perte **globale** (deux sondes indépendantes muettes)
ou une erreur de page ; une seule sonde muette est `INCONCLUSIVE` ; une cible introuvable est
`TEST_INFRASTRUCTURE_FAILURE`, un document en 5xx ou un réseau mort `ENVIRONMENT_FAILURE` : jamais un défaut
applicatif.

## API, client, Dashboard

Routes `…/incidents/:id/trigger/*` (`describe`, `start`, `pause`, `resume`, `cancel`, `experiments/:e/decision`,
`extend-budget` en `DECIDE`, `report`), client `incidents.trigger.*`, onglet **Déclencheurs** de l'espace
d'investigation : Incident (description interprétée, profondeur, lancement), Périmètre découvert, Explorateur
(stratégies, couverture par dimension, conditions), Exécution (derniers essais, rapport), Chronologie d'un essai,
Matrice, Reproduction minimale (première défaillance, perte de données), Code Angular, Causes (hypothèses,
vérifications à trancher), Test proposé (flow de la bibliothèque, `PROPOSED` tant qu'il n'a pas été exécuté depuis
Rapport › Non-régression).

## Tests

- `tests/unit/incident-trigger-core.test.ts` : interprète, catalogue, stratégies, oracle, delta debugging, conditions,
  première défaillance, perte de données, hypothèses, régression, rapport.
- `tests/unit/incident-trigger-angular.test.ts` : analyse Angular de `tests/fixtures/angular-app`, découverte du périmètre
  (statuts refusés compris).
- `tests/unit/incident-ui-trigger.test.ts` : l'onglet et son réducteur.
- `tests/integration/trigger-engine.test.ts` (Chromium) : le moteur sur `tests/fixtures/angular-site.ts`, dont le défaut
  n'apparaît qu'en vidant « Code » puis en ouvrant et fermant « Notes » avant « Enregistrer » : découverte sans que la
  description cite ces conditions, faux positifs écartés, répétition, minimisation, conditions, perte de données,
  hypothèses, vérifications, test proposé ; QUICK sans code → `INCONCLUSIVE` ; reprise ; bug intermittent ;
  annulation ; pause ; navigation refusée ; erreur IA ; séquence proposée par l'IA jouée et jugée.
- `tests/integration/trigger-discovery.test.ts` (Chromium) : serveur, client, décisions (`DECIDE`, lecteur refusé),
  budget, rapport, onglet du Dashboard avec captures (`TRG_SHOTS_DIR`).

## Limites

- Seules les applications Angular (standalone ou NgModules, TypeScript + templates HTML) sont analysées statiquement ;
  la découverte dynamique fonctionne sans code (stratégies non guidées, plus lentes).
- Les facteurs explorés viennent de la page d'entrée : un déclencheur sur une autre page n'est atteint que par les
  liens et onglets de cette page.
- Le test proposé est un flow de la bibliothèque : une touche clavier ou une attente n'y est pas exprimable et est
  signalée dans les limites du run.
- Les durées d'exécution des méthodes ne sont pas mesurées : la chronologie porte les instants observés, pas des
  profils.

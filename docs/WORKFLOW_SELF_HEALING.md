# Workflow self-healing : récupérer l'INTENTION, pas seulement le localisateur

Quand une étape d'un flow n'est plus rejouable telle quelle (élément introuvable, autre
élément trouvé, élément désactivé, action exécutée sans son effet), le rejeu ne cherche pas
seulement « un autre localisateur ». Il se pose les questions d'un testeur :

```
Je ne peux pas rejouer l'action X
  → que devait accomplir X ?            (objectif fonctionnel)
  → qu'exige la suite du parcours ?     (étapes suivantes = preuves)
  → pourquoi n'y sommes-nous pas ?      (DivergenceAnalyzer : symptôme ≠ cause)
  → quelles actions SÛRES y mènent ?    (RecoveryPlanner + SafetyPolicy)
  → laquelle a les meilleures preuves ? (score centralisé, ambiguïté visible)
  → exécuter, VÉRIFIER l'objectif       (GoalBasedRecoveryEngine, recherche bornée)
  → le parcours d'origine continue-t-il ? (l'étape suivante confirme)
  → apprendre, détecter la dérive, proposer un flow mis à jour (jamais réécrit)
```

Rien de tout cela ne s'exécute quand le rejeu se passe bien : l'analyse ne démarre qu'à une
divergence. Un rejeu sans écart coûte la même chose qu'avant.

## Architecture

| Composant                 | Fichier                                        | Rôle                                                                                      |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DivergenceAnalyzer`      | `src/workflow-healing/divergence-analyzer.ts`  | Symptôme → hypothèses de cause classées (confiance + preuves), première divergence        |
| `WorkflowContextResolver` | `src/workflow-healing/workflow-context.ts`     | Étapes précédentes, courante, suivantes ; champs exigés par la suite ; intention          |
| `WorkflowIntentResolver`  | `src/workflow-healing/workflow-context.ts`     | Intention (`OPEN_COMPANY_INFORMATION`) et objectif (`COMPANY_INFORMATION_AVAILABLE`)      |
| `RecoveryPlanner`         | `src/workflow-healing/recovery-planner.ts`     | Candidats (écran, historique, code source, dépendances), score centralisé, SafetyPolicy   |
| `GoalBasedRecoveryEngine` | `src/workflow-healing/goal-recovery-engine.ts` | Recherche bornée, progression 0..1, anti-boucle, annulation des expériences               |
| Mémoire des récupérations | `src/knowledge/json-knowledge-base.ts`         | `recoveries` dans la KnowledgeBase : succès ET échecs, version, vieillissement            |
| `FlowDriftDetector`       | `src/workflow-healing/flow-drift.ts`           | Faits de dérive, classification, résultat du rejeu, flow suggéré (générateurs du Dry Run) |
| `WorkflowHealer`          | `src/workflow-healing/workflow-healer.ts`      | Orchestration ; l'explorateur ne fournit que les accès (écran, réseau, SafetyPolicy)      |

L'exécuteur Playwright reste un exécuteur : il n'y a pas de `if bouton absent… if onglet…`
dans le rejeu. Tout le raisonnement est dans ces modules, testés sans navigateur.

## Divergence : symptôme ≠ cause

Chaque hypothèse a une confiance 0..1 et ses preuves ; la plus probable devient la
catégorie, les autres restent visibles (une hypothèse faible n'est jamais une certitude).

`TARGET_MOVED`, `TARGET_RENAMED`, `TARGET_REPLACED`, `TARGET_NOT_RENDERED`, `TARGET_DISABLED`,
`TARGET_HIDDEN`, `PARENT_SECTION_CLOSED`, `WRONG_TAB_SELECTED`, `WRONG_WORKFLOW_STATE`,
`PREREQUISITE_MISSING`, `ASYNC_DATA_NOT_READY`, `NETWORK_DEPENDENCY_NOT_READY`,
`OVERLAY_BLOCKING`, `LOCATOR_STALE`, `ROUTE_CHANGED`, `COMPONENT_RESTRUCTURED`,
`AUTH_STATE_CHANGED`, `ROLE_PERMISSION_CHANGED`, `BUSINESS_RULE_CHANGED`,
`APPLICATION_BEHAVIOR_CHANGED`, `RECORDED_FLOW_OBSOLETE`, `EXPECTED_EFFECT_CHANGED`,
`AMBIGUOUS_UI`, `UNKNOWN_DIVERGENCE`.

- **Première divergence** : une étape dont l'écran a changé, mais pas comme enregistré
  (`EXPECTED_EFFECT_CHANGED`), est acceptée provisoirement (`effect.deferred`) ; si l'étape
  suivante échoue, la divergence d'origine est cette étape-là (`Root divergence: step 7 …
(symptom at step 12)`).
- **Aucune récupération** n'est tentée quand la cause l'interdit :
  `ROLE_PERMISSION_CHANGED`, `AUTH_STATE_CHANGED` (jamais de contournement d'une autorisation),
  `APPLICATION_BEHAVIOR_CHANGED` (l'action d'origine existe, l'application répond mal :
  le self-healing ne masque pas une régression).
- Une correspondance PARTIELLE de nom (« Company information » dans « Remove company
  information ») qui change la nature de l'action (SAFE → DANGEROUS) n'est jamais cliquée :
  `TARGET_NAME_MISMATCH`.

## Objectif fonctionnel

Un objectif n'est pas un localisateur. Ses prédicats viennent de ce qui a été appris et de
ce que la suite exige :

| Prédicat            | Source                                          |
| ------------------- | ----------------------------------------------- |
| `VISIBLE_CONTROL`   | `effects.appears` appris à l'enregistrement     |
| `VISIBLE_FIELD`     | les champs que les étapes suivantes remplissent |
| `CONTROL_AVAILABLE` | la cible de l'étape suivante (activée)          |
| `ROUTE`             | `effects.route`                                 |
| `ABSENT_CONTROL`    | `effects.disappears`                            |

La progression va de 0 à 1 (`PARTIAL`), pas seulement atteint / pas atteint. Sans aucun
prédicat, l'objectif reste `UNRESOLVED` et rien n'est tenté (on n'invente pas d'intention).
L'ancien bouton et le nouvel onglet atteignent le même objectif : le type de contrôle peut
changer (bouton → onglet → entrée de menu), l'intention reste.

## Planification et sécurité

```
score = 0,35 similarité + 0,15 progression attendue + 0,10 effet attendu
      + 0,15 contexte du parcours + 0,15 preuve statique + 0,30 succès historique
      + 0,10 preuve runtime − risque − ambiguïté − instabilité − 0,05 × (actions − 1)
```

- Le score **ordonne** ; il n'autorise rien. Chaque candidat passe par la SafetyPolicy :
  seul `SAFE` est essayé (onglets, sections, menus, cases à cocher sans envoi) ; un candidat
  `MUTATION` / `DANGEROUS` est écarté et listé avec sa raison, même s'il ressemble davantage.
  L'historique est rejugé, et la garde d'écriture reste active pendant chaque expérience.
- **Ambiguïté** : deux candidats aussi plausibles, sans preuve qui les départage →
  `AMBIGUOUS_RECOVERY` (`onAmbiguity: stop`, par défaut) ; `experiment` essaie le moins
  coûteux (SAFE, vérifié par l'objectif).
- **Code source** (`StaticApplicationGraph`, en cache) et **graphe des dépendances de champs** :
  des preuves qui SUGGÈRENT (un composant dont le nom rejoint le contrôle et qui déclare les
  champs attendus). Seul l'objectif vérifié au runtime confirme.

## Recherche bornée

`état → candidat A / B / C → état observé → progression`. Une action qui DÉBLOQUE l'écran
(nouveaux contrôles) sans atteindre l'objectif ouvre un niveau de plus : c'est ainsi qu'un
**prérequis inséré** est découvert (une nouvelle question obligatoire avant l'onglet). Une
expérience qui ne mène à rien est annulée (case décochée, section refermée, retour arrière).
`visited(état, objectif, candidat)` empêche les boucles. Un budget atteint donne
`RECOVERY_BUDGET_EXHAUSTED` (inconclusif), jamais « inaccessible ».

Résultats : `GOAL_REACHED`, `GOAL_ALREADY_REACHED` (l'étape est peut-être obsolète),
`NO_SAFE_RECOVERY`, `AMBIGUOUS_RECOVERY`, `RECOVERY_BUDGET_EXHAUSTED`.

## Mémoire des récupérations

Dans la KnowledgeBase existante (`knowledge/knowledge-base.json`), par action enregistrée
et objectif : chaque chemin essayé, ses succès et ses échecs, sa version et sa date.

- Une récupération n'est apprise qu'après avoir atteint l'objectif **et** que l'étape
  suivante a réussi (`nextActionVerified`).
- L'historique est un CANDIDAT : poids = échantillon × part de succès × récence
  (KnowledgeAging) × version (0,7 pour une autre version). Il est toujours revérifié.
- Un chemin qui échoue perd du poids, n'est jamais supprimé ; un chemin qui n'a jamais réussi
  et a échoué deux fois est évité.

## Dérive du flow et flow suggéré

Des faits, pas un score : actions exactes, guéries, récupérées, insérées, possiblement
obsolètes, effets changés, ambiguës, non vérifiées.

| Résultat du rejeu           | Quand                                                  |
| --------------------------- | ------------------------------------------------------ |
| `PASS_EXACT`                | rien n'a dérivé                                        |
| `PASS_WITH_LOCATOR_HEALING` | seulement des localisateurs guéris                     |
| `PASS_WITH_GOAL_RECOVERY`   | des cibles renommées ou remplacées, objectifs vérifiés |
| `PASS_WITH_WORKFLOW_DRIFT`  | prérequis insérés, étapes obsolètes, effets changés    |
| `FAIL_NO_SAFE_RECOVERY`     | aucun chemin sûr (ou accès refusé : jamais contourné)  |
| `FAIL_BUSINESS_DIVERGENCE`  | l'action d'origine existe, l'application répond mal    |
| `INCONCLUSIVE`              | ambiguïté, budget atteint                              |

Classification : `NO_DRIFT`, `MINOR_UI_DRIFT`, `STRUCTURAL_UI_DRIFT`, `WORKFLOW_DRIFT`,
`POSSIBLE_BUSINESS_RULE_DRIFT`, `POSSIBLE_REGRESSION`, `INCONCLUSIVE`. Une règle métier
changée n'est jamais conclue sans preuve : un prérequis inséré est une dérive du PARCOURS
(`WORKFLOW_DRIFT`), signalée pour revue.

Quand une mise à jour est utile, `reports/suggested-flows/<flow>.flow.yaml` et `.feature`
sont écrits avec les générateurs du Dry Run : actions récupérées (`RUNTIME_RECOVERED`,
`ALTERNATIVE`), prérequis insérés (`INSERTED`), étapes peut-être obsolètes gardées en
commentaire (`POSSIBLY_OBSOLETE`), effets changés retirés (à réapprendre). **Le flow d'origine
n'est jamais modifié** (`autoUpdateFlow` ne peut valoir que `false`).

## Rapport

Pour chaque récupération (CLI, `index.html`, `result.json`) : action d'origine, symptôme,
cause probable et autres hypothèses, preuves, étapes précédentes et suivantes, objectif et
prédicats, candidats (source, score, risque), candidats écartés par la SafetyPolicy, choix
et raisons (« WHY DID YOU CHOOSE THIS? »), chemin, expériences, vérification de l'objectif,
résultat de l'étape suivante. Par flow : faits de dérive, résultat, fichiers suggérés.
Pour le run : tentatives, réussites, échecs, profondeur moyenne, usage du code source et de
l'historique, flows qui dérivent.

Événements (`engine-log.jsonl`) : `DIVERGENCE_ANALYSIS_STARTED`, `DIVERGENCE_CLASSIFIED`,
`ROOT_CAUSE_CANDIDATE_IDENTIFIED`, `WORKFLOW_CONTEXT_RESOLVED`, `FUNCTIONAL_GOAL_INFERRED`,
`RECOVERY_PLAN_CREATED`, `RECOVERY_CANDIDATE_EVALUATED`, `RECOVERY_CANDIDATE_REJECTED`,
`GOAL_RECOVERY_STARTED`, `GOAL_PROGRESS_UPDATED`, `GOAL_REACHED`, `GOAL_RECOVERY_FAILED`,
`RECOVERY_KNOWLEDGE_LEARNED`, `FLOW_DRIFT_DETECTED`, `PREREQUISITE_DISCOVERED`,
`SUGGESTED_FLOW_UPDATE_CREATED`.

## Configuration

```yaml
replay:
  intelligentRecovery:
    enabled: true # false : le rejeu d'avant, à l'identique
    analyzeDivergence: true
    useWorkflowContext: true
    inferFunctionalGoals: true
    goalBasedRecovery: true
    useStaticKnowledge: true
    useHistoricalRecovery: true
    learnSuccessfulRecovery: true
    detectFlowDrift: true
    suggestFlowUpdates: true
    autoUpdateFlow: false # jamais true
    onAmbiguity: stop # ou experiment
    budgets:
      maxRecoveryActions: 5
      maxRecoveryDepth: 3
      maxCandidates: 10
      maxRecoveryDurationMs: 15000
      maxSafeExperiments: 8
```

## Règles

1. Le runtime confirme la connaissance statique.
2. L'historique suggère ; il ne prouve jamais.
3. La SafetyPolicy gagne toujours.
4. Une écriture n'est jamais retentée à l'aveugle.
5. Le self-healing ne masque pas une vraie régression.
6. Un flow imposé n'est jamais modifié automatiquement.
7. La récupération reste bornée.
8. L'ambiguïté reste visible.
9. Chaque récupération est explicable.
10. Les étapes suivantes sont des preuves.
11. L'intention métier est plus stable qu'un sélecteur CSS.
12. L'objectif fonctionnel est plus stable que l'implémentation d'un bouton.

## Récupération par objectif fonctionnel : récupérer l'état, pas le sélecteur

Un localisateur n'est que la représentation technique d'une cible. Quand la cible elle-même
n'est pas disponible, QA-Crawler raisonne sur les objectifs, les préconditions, les
dépendances et le parcours humain avant de toucher au sélecteur.

### Ce qu'un vrai run a montré

Une étape `fill css=#valueInput` (un champ valeur sans nom accessible, après deux choix de
filtre) a échoué avec `TARGET_FINGERPRINT_MISMATCH: expected "", found (not clicked)`, puis
`LOCATOR_STALE 0.8`, des candidats sans rapport et `RECOVERY_BUDGET_EXHAUSTED`. Trois causes :

| Cause                                                                                                                                                                                                                      | Correction                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L'élément trouvé a été re-rendu avant d'être lu : une **observation vide** donnait 0.4 → `MISMATCH` sans raison → `LOCATOR_STALE 0.8`                                                                                      | L'élément est relocalisé et relu (deux fois). Sans identité enregistrée (ni nom, ni texte, ni test id), un élément illisible ne prouve pas un mauvais élément ; avec une identité, il est rapporté `TARGET_NOT_FOUND`, jamais « un autre élément ». `matchFingerprint` donne toujours une raison. |
| L'objectif de récupération prenait le **sélecteur pour un libellé** : `field "#valueInput" visible` était vérifié par nom accessible — insatisfiable, donc toute récupération (et la proposition IA) était perdue d'avance | Un prédicat d'objectif garde le localisateur enregistré (`GoalPredicate.target`) pour une cible css / test id, et se vérifie par lui (existe, visible, utilisable).                                                                                                                               |
| `TARGET_MISMATCH` valait toujours `LOCATOR_STALE 0.8`, et des contrôles SÛRS sans lien avec la cible (score 0.05) consommaient le budget                                                                                   | `ExpectedTargetAnalysis` rééquilibre les hypothèses ; les candidats sans lien ne sont pas essayés quand la cible est absente fonctionnellement.                                                                                                                                                   |

### Deux phases

**PHASE 1 — DIAGNOSTIC** (`src/workflow-healing/expected-target.ts`), pour une action sur un
**champ** (`fill`, `select`) introuvable ou non conforme ; un bouton renommé reste traité par la
récupération existante (renommé, remplacé, déplacé) :

- le localisateur enregistré est sondé (attaché, visible, lisible — rien n'est cliqué) ;
- `presence` : `PRESENT`, `PRESENT_SIMILAR` (même rôle, nom voisin), `HIDDEN`, `UNSTABLE` (re-rendu), `ABSENT` ;
- ce qui révèle la cible : les effets appris des étapes précédentes (`effects.appears`), le choix juste avant un champ (une _hypothèse_), le graphe causal (une hypothèse tant que le runtime ne l'a pas confirmée) ;
- la section parente : un contrôle replié (`aria-expanded=false`), un onglet non sélectionné ;
- la chaîne de préconditions, du but vers la cause la plus profonde : `FILL X ← X_AVAILABLE ← SECTION_OPEN ← CHOICE_DONE` ;
- les causes rééquilibrées :
  - `LOCATOR_STALE` n'est fort (0.85) que si le contrôle fonctionnel **semble présent** (même rôle, nom voisin) ;
  - une cible absente est `TARGET_NOT_RENDERED`, et la question devient **pourquoi** : `PARENT_SECTION_CLOSED`, `PREREQUISITE_MISSING`, `WRONG_WORKFLOW_STATE` ; `LOCATOR_STALE` est plafonné à 0.2.

L'analyse sépare le symptôme technique (`TARGET_FINGERPRINT_MISMATCH`) de la cause fonctionnelle.

**PHASE 2 — ACTION** (seulement ensuite) : l'objectif devient _atteindre `X_AVAILABLE`_, pas
_réparer le sélecteur_. Le planificateur :

- classe d'abord les contrôles qui établissent une précondition manquante : la section parente, l'action enregistrée qui révélait la cible (source `HUMAN_JOURNEY` ; c'est la seule étape précédente qui peut être rétablie) ;
- n'essaie pas les candidats sans lien avec la cible (`budgets.minCandidateRelevance`, 0.15 par défaut) : les variantes de localisateur ne consomment jamais le budget de la récupération fonctionnelle ;
- garde chaque candidat derrière la SafetyPolicy : un contrôle MUTATION ou UNKNOWN n'est jamais exécuté (`NO_SAFE_RECOVERY`) ;
- vérifie chaque action insérée par son effet et la progression de l'objectif ; pour un champ, l'action trouvée est un prérequis inséré et la cause confirmée est la cause fonctionnelle.

### Copilot

Quand la récupération déterministe échoue, on ne demande plus au conseiller « un autre
localisateur », mais : _étant donné l'état fonctionnel, la cible attendue, les dépendances
connues, le parcours enregistré et les actions SÛRES disponibles, quelle précondition
manquante empêche le plus probablement la cible d'apparaître ?_ Il reçoit la chaîne de
préconditions et les hypothèses rééquilibrées. Sa proposition passe toujours par le
ProposalValidator, l'EvidenceValidator, la SafetyPolicy et la vérification au runtime.

### Rapport

Chaque récupération montre :

- le symptôme technique ;
- la cible attendue : présence, contrôles voisins, section parente ;
- la chaîne de préconditions et les préconditions manquantes ;
- les révélateurs, avec leur statut d'hypothèse et leur présence à l'écran ;
- le mode : `FUNCTIONAL_RECOVERY` ou `LOCATOR_HEALING` ;
- la cause fonctionnelle ;
- les candidats et leur sûreté ;
- la récupération retenue et la progression de l'objectif ;
- `Result: RECOVERED / NOT_RECOVERED / INCONCLUSIVE`.

Événement : `EXPECTED_TARGET_ANALYZED`.

### Classification de sûreté

La classification reste sémantique : un contrôle est MUTATION par son intention (texte,
formulaire, effet réseau, effet appris), jamais parce que c'est un bouton. Un comportement
inconnu (une icône sans libellé) est `UNKNOWN` et n'est jamais exécuté automatiquement ;
QA-Crawler n'invente jamais SAFE.

### Tests

- `tests/unit/functional-goal-recovery.test.ts` couvre :
  - la section parente fermée ;
  - le vrai localisateur périmé ;
  - la cible non rendue derrière un choix précédent ;
  - le chemin uniquement MUTATION ;
  - l'entrée du conseiller ;
  - le budget ;
  - le prédicat de champ par localisateur ;
  - l'élément illisible.
- `tests/integration/functional-goal-recovery.test.ts` (navigateur réel) reproduit un panneau de filtre dont le champ valeur (`#valueInput`, sans nom) est passé dans une section repliée. Il est récupéré en l'ouvrant, vérifié par son localisateur, sans essayer de bouton sans rapport.

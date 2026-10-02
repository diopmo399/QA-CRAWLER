# QA Cognitive Engine

Faire de QA-Crawler un système qui **comprend, planifie, teste ses hypothèses, apprend, se
corrige et explique** — en restant déterministe quand c'est possible, prudent quand il est
incertain, sûr par construction et vérifiable par le runtime.

| Source        | Ce qu'elle vaut                         |
| ------------- | --------------------------------------- |
| Runtime       | la vérité observable actuelle           |
| Démonstration | une preuve d'intention                  |
| Code source   | une preuve d'implémentation (suggère)   |
| OpenAPI       | une preuve de contrat (suggère)         |
| Historique    | une expérience (vieillit)               |
| LLM           | une proposition : au plus une hypothèse |

## Audit : ce qui existe déjà (et sera réutilisé)

| Concept demandé    | Existant                                                                                                       | Décision                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Evidence           | `SemanticEvidence` + `EvidenceSource` (analyse statique, résolveur)                                            | **étendu** : `Evidence` typé (+ HUMAN_RECORDING, TEST_RESULT, LLM_PROPOSAL), conversion |
| Evidence graph     | `EvidenceEdge` (statique), `StaticKnowledge` (index)                                                           | **étendu** : `EvidenceGraph` avec provenance ; le graphe statique y est importé         |
| Functional model   | `FunctionalIntelligence` (machines à états, workflows, invariants, effets, contrat)                            | **réutilisé** (`addWorkflows`) + `FunctionalModel` (capacités, phases, choix, envoi)    |
| Business state     | `BusinessState` = état du cycle de vie d'une entité (machines à états)                                         | **nouveau** `BusinessStateEngine` → `BusinessSituation` (état métier de l'écran)        |
| Confidence / aging | `ConfidenceEngine`, `KnowledgeAging` (`recencyWeight`), `sampleConfidence`                                     | **réutilisés** (poids des preuves, vieillissement, versions)                            |
| KnowledgeBase      | `JsonKnowledgeBase` (actions, transitions, API, récupérations)                                                 | **étendu** : `cognitive` (hypothèses + preuves) — pas de deuxième base                  |
| Goal planner       | `RuleBasedGoalPlanner` (mission → objectifs d'exploration), `TestGoalPlanner`, `FunctionalGoal` (self-healing) | à étendre (lot D) : graphe d'objectifs et préconditions                                 |
| Invariants         | `InvariantAnalyzer` (statique), `InvariantOracle`                                                              | à étendre (lot H) : découverte runtime CANDIDATE → CONFIRMED                            |
| Failures           | `ErrorPath`, `DivergenceAnalyzer`, oracles                                                                     | à étendre (lot H) : taxonomie + `FailureKnowledge`                                      |
| Coverage           | `CoverageTracker` (UI), `FunctionalCoverage`, `RuleCoverage`                                                   | à étendre (lot I) : `FunctionalCoverageGraph`                                           |
| Plan / recovery    | `GoalBasedRecoveryEngine`, `FlowDriftDetector`, Dry Run (`FlowAlignment`)                                      | à étendre (lot E) : `PlanEngine`, `PlanRepairEngine`, `SemanticCheckpoint`              |
| Decision           | `DecisionEngine`, `AdvancedActionScorer`, `DecisionTrace`                                                      | à étendre (lot J) : `QAReasoningEngine` produit une décision, ne clique pas             |
| Safety             | `SafetyPolicy`, `WriteGuard`                                                                                   | **inchangés, absolus**                                                                  |
| Persistence        | KnowledgeBase JSON, persistance (InMemory / JSON / DB)                                                         | **réutilisée**                                                                          |

## Lots

| Lot | Contenu                                                                                    | État      |
| --- | ------------------------------------------------------------------------------------------ | --------- |
| A   | `Evidence`, `EvidenceStore`, `EvidenceGraph` (provenance, versions), import du code source | ✅ ce lot |
| B   | `FunctionalModel`, `BusinessStateEngine`, `FunctionalState`                                | ✅ ce lot |
| C   | `HypothesisEngine`, `CausalKnowledgeGraph` (corrélation ≠ causalité)                       | ✅ ce lot |
| D   | `GoalGraph`, `PreconditionResolver`                                                        | suivant   |
| E   | `PlanEngine`, `PlanRepairEngine`, `SemanticCheckpoint`                                     |           |
| F   | `InformationGainEstimator`, `ActiveLearningEngine`, `ExperimentProposal` (SafetyPolicy)    |           |
| G   | `ContradictionDetector`, `TemporalDependencyGraph`                                         |           |
| H   | `InvariantDiscoveryEngine`, `FailureUnderstandingEngine`, `FailureKnowledge`               |           |
| I   | `FunctionalCoverageGraph`, exploration guidée par la couverture                            |           |
| J   | `QAReasoningEngine` (contexte, décision WHY / WHY NOT, chemin rapide / profond)            |           |
| K   | `ReasoningAdvisor` (déterministe ; LLM optionnel, sans dépendance du cœur)                 |           |
| L   | rapports, artefacts JSON, persistance, E2E (application V1 → V2)                           |           |

## Lot A — Preuves (`src/cognitive/evidence.ts`, `evidence-graph.ts`)

- `Evidence { id, type, source, timestamp, applicationVersion, confidence, details }` ; `details`
  ne porte que des noms, codes et compteurs (jamais une valeur saisie).
- Le **type plafonne** le poids : RUNTIME 1 · DOM / NETWORK / TEST_RESULT 0,95 ·
  HUMAN_RECORDING 0,8 · STATIC_SOURCE / OPENAPI / BUSINESS_RULE 0,6 · HISTORICAL 0,5 ·
  LLM_PROPOSAL 0,2. Le poids vieillit (`recencyWeight`) et baisse pour une autre version.
- Les poids se combinent (noisy-or) sans jamais atteindre 1.
- `EvidenceGraph` : contrôles, champs, composants, routes, actions, DTO, API, règles, objectifs,
  états, actions humaines, observations, échecs, récupérations. **Chaque relation garde sa
  provenance** : sources, preuves, confiance, version, premier / dernier vu, nombre
  d'observations, `runtimeConfirmed`. Sans preuve runtime, la confiance reste plafonnée (0,8) ;
  proposée seulement par un LLM, 0,3.
- Le graphe statique (en cache) est importé : route → composant, composant → champ,
  champ → propriété du DTO, champ → API.

## Lot B — Modèle fonctionnel et état métier (`functional-model.ts`, `business-state-engine.ts`)

- Un parcours démontré devient : la **mission** (`CREATE_REQUEST`), les **phases**
  (`COMPANY_INFORMATION` : ses champs, ce qui l'ouvre), les **choix** (`SELECT_EUR`), l'**envoi**.
  Les workflows de l'intelligence fonctionnelle s'y ajoutent.
- Le `BusinessStateEngine` lit l'écran (sans jamais lire une valeur) :

  ```
  mission CREATE_REQUEST · phase COMPANY_INFORMATION · Currency=EUR
  · COMPANY_INFORMATION INCOMPLETE (missing: Business number) · submission BLOCKED
  ```

  Chaque fait porte une preuve DOM. `FunctionalState` : capacités (COMPLETED / AVAILABLE /
  BLOCKED / UNAVAILABLE), phase, faits, objectifs atteints, disponibles et bloqués (avec ce
  qui manque). Un champ requis, visible et vide que le modèle ne connaît pas encore compte
  comme condition manquante.

## Lot C — Hypothèses et causalité (`hypothesis-engine.ts`, `causal-graph.ts`)

```
Observation → Hypothesis → accumulation de preuves → confirmation / contradiction → Knowledge
```

| Statut              | Quand                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPOTHESIS`        | une seule observation (ou seulement un LLM, quoi qu'il arrive)                                                                                              |
| `SUPPORTED`         | plusieurs preuves                                                                                                                                           |
| `RUNTIME_CONFIRMED` | ≥ N observations runtime distinctes (2 par défaut) + une source indépendante (code, règle, démonstration, expérience contrôlée), sans contradiction runtime |
| `CONTRADICTED`      | une contradiction runtime au moins aussi forte que le soutien                                                                                               |
| `REJECTED`          | contredite deux fois au runtime, jamais observée                                                                                                            |
| `STALE`             | confirmée sur une autre version, pas revue au runtime sur celle-ci                                                                                          |

Le `CausalKnowledgeGraph` porte les relations `REQUIRES, ENABLES, DISABLES, REVEALS, HIDES,
POPULATES, CLEARS, VALIDATES, INVALIDATES, NAVIGATES_TO, TRIGGERS, DEPENDS_ON, PREVENTS,
TRANSITIONS_TO`. Chaque action exécutée (flow ou exploration) en propose : contrôles apparus
(REVEALS), activés (ENABLES), désactivés, disparus, route (NAVIGATES_TO), requêtes (TRIGGERS).
Les effets appris à l'enregistrement sont une preuve HUMAN_RECORDING de la même relation.

Les hypothèses (bornées) et leurs preuves sont gardées dans la KnowledgeBase et **réévaluées**
au run suivant (âge, version) : l'historique est une expérience, pas une vérité.

## Lot D — Objectifs et préconditions (`goal-graph.ts`)

La mission devient un **graphe d'objectifs** (modèle fonctionnel + graphe causal) :

```
CREATE_REQUEST_DONE                       (envoi : action qui écrit)
  ↑ CREATE_REQUEST_READY                  (envoi possible)
      ↑ EUR_SELECTED                      (choix démontré)
      ↑ COMPANY_INFORMATION_COMPLETE
          ↑ COMPANY_INFORMATION_AVAILABLE ← COMPANY_INFORMATION_CONTROL_AVAILABLE ← EUR_SELECTED (appris : « check EUR révèle l'ouvreur »)
          ↑ COMPANY_NAME_VALID · BUSINESS_NUMBER_VALID
```

Chaque nœud dit comment il peut être réalisé (`achievedBy` : plan démontré, modèle, ou
relation causale avec le statut de son hypothèse). Le **PreconditionResolver** ne répond pas
« BLOCKED » mais POURQUOI : les chaînes du but jusqu'à la condition manquante la plus profonde,
les préconditions actionnables maintenant, leurs actions candidates et les preuves de l'écran.

```
CREATE_REQUEST_DONE ← CREATE_REQUEST_READY ← COMPANY_INFORMATION_COMPLETE ← BUSINESS_NUMBER_VALID
→ fill "Business number"
```

## Lot E — Plans et checkpoints (`planning.ts`)

- **SemanticCheckpoint** : un état métier (phase complète, prêt, terminé). Confirmé quand sa
  condition est vraie, qu'au moins deux sous-conditions sont vérifiées à l'écran et qu'une
  preuve observée existe — **jamais l'URL seule**. Une interface restructurée (bouton → onglet,
  autre route) qui atteint le même état atteint le même checkpoint. Un checkpoint confirmé puis
  démenti devient `CONTRADICTED`.
- **PlanEngine** : état + objectif + préconditions → `ExecutionPlan` (étapes de la condition
  la plus profonde jusqu'au but, checkpoints, confiance, `assumptions` : les hypothèses non
  confirmées dont il dépend, `alternatives` : les autres candidats).
- **Plan ≠ flow enregistré** : `RECORDED_PLAN` (le parcours démontré, connu), `CURRENT_PLAN`
  (depuis l'état atteint), `RECOVERED_PLAN` et `SUGGESTED_PLAN` (réparés).
- **PlanRepairEngine** : `A → B → C → D` devient `A → B → X → D` à partir d'une récupération
  confirmée au runtime ; chaque action insérée repasse par la SafetyPolicy, et une action qui
  écrirait là où l'étape d'origine ne le pouvait pas est refusée (`UNSAFE`, aucun plan). Le
  plan enregistré n'est jamais modifié.

Événements ajoutés : `GOAL_CREATED`, `GOAL_BLOCKED`, `PRECONDITION_DISCOVERED`,
`PLAN_CREATED`, `PLAN_REPAIRED`, `SEMANTIC_CHECKPOINT_REACHED`. Vues : `goal-graph.json`,
`plan.json` (plans par flow, réparation, préconditions, checkpoints).

## Observabilité

Événements (`engine-log.jsonl`) : `EVIDENCE_ADDED`, `HYPOTHESIS_CREATED`,
`HYPOTHESIS_SUPPORTED`, `HYPOTHESIS_CONTRADICTED`, `CAUSAL_RELATION_CONFIRMED`,
`BUSINESS_STATE_UPDATED`.

Vues de débogage (`reports/cognitive/`) : `knowledge-graph.json`, `causal-graph.json`,
`hypotheses.json`, `functional-model.json`, `business-state.json`.

## Configuration

```yaml
cognitive:
  enabled: true # false : aucune observation, aucun artefact
  learnCausality: true
  businessState: true
  runtimeObservationsToConfirm: 2
  writeArtifacts: true
  budgets:
    maxHypotheses: 500
```

Le moteur observe et apprend ; il ne clique jamais, n'appelle pas Playwright, ne contourne
aucune politique. Le coût par action est une comparaison d'ensembles de contrôles.

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

| Lot | Contenu                                                                                    | État |
| --- | ------------------------------------------------------------------------------------------ | ---- |
| A   | `Evidence`, `EvidenceStore`, `EvidenceGraph` (provenance, versions), import du code source | ✅   |
| B   | `FunctionalModel`, `BusinessStateEngine`, `FunctionalState`                                | ✅   |
| C   | `HypothesisEngine`, `CausalKnowledgeGraph` (corrélation ≠ causalité)                       | ✅   |
| D   | `GoalGraph`, `PreconditionResolver`                                                        | ✅   |
| E   | `PlanEngine`, `PlanRepairEngine`, `SemanticCheckpoint`                                     | ✅   |
| F   | `InformationGainEstimator`, `ActiveLearningEngine`, `ExperimentProposal` (SafetyPolicy)    | ✅   |
| G   | `ContradictionDetector`, `TemporalDependencyGraph`                                         | ✅   |
| H   | `InvariantDiscoveryEngine`, `FailureUnderstandingEngine`, `FailureKnowledge`               | ✅   |
| I   | `FunctionalCoverageGraph`, exploration guidée par la couverture                            | ✅   |
| J   | `QAReasoningEngine` (contexte, décision WHY / WHY NOT, chemin rapide / profond)            | ✅   |
| K   | `ReasoningAdvisor` (déterministe ; LLM optionnel, sans dépendance du cœur)                 | ✅   |
| L   | rapports, artefacts JSON, persistance, E2E (application V1 → V2)                           | ✅   |

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

## Lot F — Apprentissage actif (`active-learning.ts`)

Quand plusieurs causes expliquent un même effet (« EUR révèle le formulaire » / « l'entretien
le révèle »), l'**InformationGainEstimator** mesure la baisse d'entropie attendue (bits) d'une
expérience qui exécute une seule cause ; l'**ActiveLearningEngine** propose les expériences
SÛRES (`ExperimentProposal` : hypothèses, actions, résultats attendus, gain, classe de sécurité,
réversibilité, coût), les réversibles d'abord. Une expérience exécutée produit une preuve
`TEST_RESULT` (`experiment: true`) : soutien si l'effet apparaît, contradiction sinon, puis
l'expérience est annulée. **DELETE, PAY, APPROVE, SUBMIT, SEND, PUBLISH, droits… ne sont jamais
expérimentés** : la SafetyPolicy refuse, la raison est gardée, rien n'est exécuté.

## Lot G — Contradictions et temporalité (`contradictions.ts`)

- **ContradictionDetector** : démonstration, runtime, code, OpenAPI, historique et règles sur
  une même propriété. `SOURCE_RUNTIME_MISMATCH`, `OPENAPI_RUNTIME_MISMATCH`,
  `HUMAN_RUNTIME_MISMATCH`, `HISTORY_RUNTIME_MISMATCH`, `BUSINESS_RULE_RUNTIME_MISMATCH`,
  `CONTRACT_IMPLEMENTATION_MISMATCH`. Jamais résolue en silence : enregistrée, visible,
  pénalité de confiance, investigation SAFE proposée. Branché : `required` déclaré par l'écran
  vs `Validators.required` du code (graphe statique).
- **TemporalDependencyGraph** : `BEFORE, AFTER, DURING, UNTIL, EVENTUALLY, TRIGGERS, WAITS_FOR,
COMPLETES_BEFORE`. Un contrôle apparu après la fin d'une requête l'**attend** (latence
  observée) : on n'apprend pas « visible immédiatement ».

## Lot H — Invariants et échecs (`invariants-failures.ts`)

- **InvariantDiscoveryEngine** : « l'envoi reste désactivé tant que les champs requis ne sont pas
  valides », « choisir la devise ne vide pas le nom ». `CANDIDATE → OBSERVED_MULTIPLE_TIMES →
SUPPORTED → CONFIRMED` (observations ET runs distincts, `cognitive.invariants.*`) ; un
  contre-exemple sur un invariant soutenu → `VIOLATED` (avertissement avec sa provenance : runs,
  observations, contre-exemple) ; autre version non revue → `STALE`. Une seule observation ne
  fait jamais un invariant fort.
- **FailureUnderstandingEngine** : `EXPECTED_VALIDATION, EXPECTED_BUSINESS_REJECTION, UI_FAILURE,
FUNCTIONAL_FAILURE, API_FAILURE, TECHNICAL_FAILURE, CONTRACT_FAILURE, PERMISSION_FAILURE,
DATA_FAILURE, TIMEOUT_FAILURE, WORKFLOW_FAILURE, UNKNOWN_FAILURE`, avec la chaîne
  symptôme → divergence → cause probable → récupération connue → occurrences.
- **FailureKnowledge** (KnowledgeBase) : « j'ai déjà vu cette classe de panne ici ».

## Lot I — Couverture fonctionnelle (`functional-coverage.ts`)

```
Currency: ✓ EUR  ? CAD
Company information: ✓ valid Business number  ? invalid Business number  ? missing Business number
Submission: ✓ success  ? validation rejection  ? API unavailable
```

Dimensions : capacités, choix, champs (valide / invalide / manquant), envois, transitions,
checkpoints, invariants, rôles, API. Beaucoup de pages visitées n'implique pas « numéro invalide
testé » : les trous restent visibles, classés par importance métier, et `nextGoal()` donne la
prochaine raison d'explorer (`COVERAGE`) — un chemin négatif important plutôt qu'un bouton
jamais cliqué.

Événements : `CONTRADICTION_DETECTED`, `ACTIVE_LEARNING_STARTED`, `EXPERIMENT_PROPOSED`,
`EXPERIMENT_COMPLETED`, `INVARIANT_CANDIDATE_CREATED`, `INVARIANT_CONFIRMED`,
`INVARIANT_VIOLATED`, `FAILURE_CLASSIFIED`, `FUNCTIONAL_COVERAGE_UPDATED`. Vues :
`contradictions.json`, `functional-coverage.json`, `invariants.json`, `failures.json`,
`temporal.json`, `experiments.json`.

## Lot J — QA Reasoning Engine (`reasoning-engine.ts`)

Il **ne clique pas**, n'appelle pas Playwright, ne contourne pas la SafetyPolicy et n'écrit pas
dans la KnowledgeBase : il produit une `QAReasoningDecision` (but, raison, action, intention,
effets attendus, preuves, confiance, hypothèses supposées, alternatives écartées, checkpoint visé).

- **FAST PATH** : plan connu et confiant, prochaine étape à l'écran → décision déterministe.
- **DEEP PATH** : utilité centralisée (§22)

  ```
  goalProgress + functionalCoverageGain + novelty + informationGain + businessImportance
  + expectedKnowledgeGain + historicalSuccess + runtimeEvidence
  − repetition − instability − ambiguity − actionCost − recoveryCost
  ```

  La sécurité n'est **pas** un poids : une action non SAFE (ou non permise) est écartée avec sa
  raison. Toute décision a une raison (`GOAL`, `COVERAGE`, `HYPOTHESIS`, `RECOVERY`,
  `CONTRADICTION`, `INVARIANT`) : pas d'exploration au hasard (`INCONCLUSIVE` sinon).

- **WHY / WHY NOT** : `GOAL_PRECONDITION`, `NEXT_FIELDS_DEPEND_ON_TARGET`, `SEMANTIC_MATCH`,
  `STATIC_COMPONENT_MATCH`, `RUNTIME_TARGET_EXISTS`, `HISTORICAL_SUCCESS`, `COVERAGE_GAP`,
  `HYPOTHESIS_TEST`, `SAFE_ACTION` ; écartées : `UNSAFE`, `MUTATION_NOT_REQUIRED`,
  `DIFFERENT_INTENT`, `WEAK_RELATIONSHIP`, `NO_EXPECTED_GOAL_EVIDENCE`, `REPETITION`, `LOWER_UTILITY`.
- Un récit structuré (§125) accompagne chaque décision : phase, but, ce qui bloque, ce qui est
  supposé, pourquoi cette action, ce qui sera vérifié. Pas de chaîne de pensée libre.
- **Intégration sans second moteur de décision** : une décision par écran, donnée au moteur
  existant comme un facteur du score (`cognitive`, `cognitive.reasoning.decisionWeight`). Le
  résultat de l'action décidée est enregistré (confirmé ou non) ; une décision `HYPOTHESIS`
  produit une preuve d'expérience (`TEST_RESULT`) et met à jour l'hypothèse.
- Budget : `REASONING_BUDGET_EXHAUSTED` (jamais « inaccessible »).

## Lot K — Conseiller (`reasoning-advisor.ts`)

`ReasoningAdvisor` est une abstraction ; `DeterministicReasoningAdvisor` est le défaut (n'invente
rien). `LLMReasoningAdvisor` est **optionnel** et le cœur ne dépend d'aucun fournisseur : il
n'existe que si l'intégrateur lui passe une fonction `complete(prompt)` (option de programme
`reasoningAdvisor`, jamais par la configuration). Consulté seulement si le déterministe ne
suffit pas (ambiguïté, intention non résolue…), dans son budget (`maxAdvisorCalls`).

Un **vrai** fournisseur (GitHub Copilot, par le SDK officiel) passe par l'`IntelligenceGateway`
(`ai.*`, modes OFF / ASSIST / HYBRID, outils de lecture seule, audit, vérification au runtime) :
voir [AI_INTELLIGENCE.md](AI_INTELLIGENCE.md).

```
proposition → schéma (zod, strict) → preuves citées existantes → action existante à l'écran
→ SafetyPolicy → exécuteur déterministe → vérification de l'effet au runtime
```

Une action inventée (« Magic Button ») est rejetée ; une affirmation (« EUR requires … ») devient
au plus une **HYPOTHÈSE** (`LLM_PROPOSAL`, confiance ≤ 0,3), jamais une connaissance confirmée.

## Lot L — Rapport, persistance

- Rapport HTML « Cognitive engine » : mission, état fonctionnel, but, chaîne de préconditions
  manquantes, plan courant, checkpoints, hypothèses (par statut), relations confirmées,
  contradictions, plans réparés, échecs classés, couverture et ce qui reste non testé,
  invariants, décisions (WHY / WHY NOT). La CLI en donne le résumé.
- `reports/cognitive/reasoning.json` (décisions, récits, conseils), en plus des autres vues.
- Persistance : la connaissance cognitive (hypothèses + preuves, invariants, échecs) vit dans la
  KnowledgeBase existante (fichier JSON, mode historique) ; elle n'est couplée à aucune base de
  données. En mémoire de travail (persistance DB), elle reste celle du run.

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
  invariants: { multiple: 3, supported: 5, confirmed: 10, runsForSupported: 2, runsForConfirmed: 3 }
  reasoning:
    enabled: true
    influenceDecisionEngine: true
    decisionWeight: 1
    advisor: deterministic # ou none ; un conseiller LLM ne s'injecte que par programme
    maxAdvisorCalls: 5
  budgets:
    maxHypotheses: 500
    maxPlanningDepth: 8
    maxExperiments: 3
    maxPlanCandidates: 30
    maxReasoningDurationMs: 250
```

Le moteur observe et apprend ; il ne clique jamais, n'appelle pas Playwright, ne contourne
aucune politique. Le coût par action est une comparaison d'ensembles de contrôles.

# Intelligence fonctionnelle : états métier, workflows, invariants, effets, objectifs de test

> Static suggests. History guides. Runtime confirms. Safety decides.

QA-CRAWLER passe d'un crawler orienté **actions** (« quel bouton n'ai-je pas encore cliqué ? ») à un moteur QA orienté **compréhension et objectifs** (« quelle connaissance fonctionnelle importante dois-je vérifier maintenant ? »).

## 1. Rapport d'architecture (avant implémentation)

### Architecture existante

| Composant existant                                                                           | Ce qu'il représente déjà                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `FlowGraph` (`graph/flow-graph.ts`), `StateDetector`                                         | états d'**écran** et transitions de navigation (état A → action → réseau → état B)         |
| `ExplorationFrontier`, `DecisionEngine`, `AdvancedActionScorer` + `ScoreBreakdown`           | choix de la prochaine action, score expliqué par facteurs                                  |
| `GoalPlanner` / `GoalTracker` (`goals/`)                                                     | objectifs de **mission** (trouver, explorer, atteindre un écran) — pas des vérifications   |
| `TestOracle`, `CompositeTestOracle`, `InvariantOracle`, `ContractOracle`, `HistoricalOracle` | jugement d'une action ; invariants **déclarés** par la mission ; statut HTTP vs OpenAPI    |
| `ApiContract` (`oracles/api-contract.ts`)                                                    | OpenAPI : opérations, réponses déclarées, champs de requête (type, format, enum, required) |
| `StaticApplicationGraph` + `ts-facts` + `RuleGraph`                                          | routes, formulaires, DTO, appels HTTP, flux de données, **règles** (conditions → effets)   |
| `FormStateAnalyzer`, `FieldDependencyGraph`, `RuntimeRuleVerifier`                           | état et provenance des champs, dépendances, règles confirmées au runtime                   |
| `CreatedDataRegistry`                                                                        | écritures réussies du run, marquées `QA-CRAWLER-<runId>`                                   |
| `FormKnowledgeObserver`                                                                      | appels XHR/fetch vus, fenêtres réseau, réponses JSON en empreintes                         |
| `KnowledgeBase` (+ `RuleKnowledgeStore`)                                                     | historique des transitions, actions, API ; règles par signature et version                 |
| Dry Run (`IntentPathResolver`, `known-paths.ts`)                                             | chemins connus vers un écran (FlowGraph, historique, code)                                 |
| `SafetyPolicy`                                                                               | classification SAFE / MUTATION / DANGEROUS, garde absolue avant Playwright                 |

### Composants réutilisés

- **États / transitions d'écran** : `FlowGraph` (chemins connus, `flowTo`) ; un état métier est **observé sur** un état d'écran, jamais confondu avec lui.
- **Conditions / effets** : `RuleCondition` et `RuleEffect` du RuleGraph servent de pré- et post-conditions aux transitions métier et aux invariants (pas de second langage de conditions).
- **Preuves** : `SemanticEvidence` (source, valeur, confiance, provenance fichier:ligne).
- **Oracles** : le nouvel oracle sémantique est un `TestOracle` de plus dans le `CompositeTestOracle` existant.
- **Score** : un facteur `functional` de plus dans le `ScoreBreakdown` existant, comme `rules`.
- **Contrat** : l'`ApiContract` existant est enrichi (schéma de réponse), pas de second analyseur OpenAPI.
- **Chemins** : `FlowGraph` (états connus) et la `KnowledgeBase` (transitions historiques), comme le Dry Run.
- **Sécurité** : `SafetyPolicy.classify()` + `evaluate()` jugent l'action déclencheuse d'un objectif ; un objectif dangereux devient BLOCKED sans rien exécuter.

### Concepts manquants

État **métier** (cycle de vie d'une entité) et ses transitions ; **workflow** fonctionnel (CREATE:USER) ; **invariant** découvert dans le code (différent des invariants déclarés de la mission) ; **effet secondaire** attendu d'une action ; **chemin d'erreur** (API → code d'erreur → message → champ) ; **observation de contrat au runtime** (corps de requête vs OpenAPI) ; **objectif de test** et son **planificateur** ; **couverture fonctionnelle**.

### Points d'intégration

1. Analyse statique (même passage sur l'AST) : enums et unions de statuts, littéraux d'un corps de requête (`{ status: 'APPROVED' }`), gardes de sortie (`if (status !== 'PENDING') return` / `throw`), gestionnaires d'erreur (`error: (e) => … setErrors`), `(click)` des boutons du gabarit.
2. `FlowExplorer.executeAndObserve` : avant / après chaque action, avec la fenêtre réseau → analyse fonctionnelle incrémentale (seules les connaissances concernées).
3. `CompositeTestOracle` : `SemanticFunctionalOracle`.
4. `AdvancedActionScorer` : signal `functional` (progression d'objectif, couverture de transitions, workflows, invariants).
5. `FormKnowledgeObserver` : forme (clés et types, jamais les valeurs) des corps de requête d'écriture et des réponses, codes d'erreur métier.
6. Rapport, `result.json`, journal du moteur, configuration.

### Fichiers modifiés

`static-analysis/ts-facts.ts`, `static-analysis/rules/code-rules.ts`, `static-analysis/rules/template-rules.ts`, `static-analysis/graph-builder.ts`, `static-analysis/model.ts`, `oracles/api-contract.ts`, `forms/state/form-knowledge-observer.ts`, `decision/advanced-action-scorer.ts`, `decision/score-breakdown.ts`, `explorer/flow-explorer.ts`, `model/issue.ts`, `model/exploration-result.ts`, `reporting/*`, `logging/engine-log.ts`, `config/config.ts`.

### Fichiers créés

`functional/model.ts`, `functional/state-machines.ts`, `functional/workflows.ts`, `functional/invariants.ts`, `functional/side-effects.ts`, `functional/error-paths.ts`, `functional/runtime-contract.ts`, `functional/test-goals.ts`, `functional/goal-planner.ts`, `functional/goal-scoring.ts`, `functional/functional-intelligence.ts`, `oracles/semantic-functional-oracle.ts`, `knowledge/functional-knowledge-store.ts`, `reporting/functional-section.ts`, tests et fixture.

### Risques de migration / non-régression

- Tout est derrière `functionalIntelligence.enabled` (faux par défaut) ; désactivé, aucun signal n'atteint le moteur de décision et aucun oracle n'est ajouté.
- Le nouvel oracle ne produit que des WARNING (catégorie `FUNCTIONAL`), jamais un échec bloquant à lui seul.
- La version de l'analyseur statique change (le cache est recalculé une fois).
- Aucune action n'est exécutée « pour » un objectif en dehors de la SafetyPolicy : un objectif ne fait que donner des points à des actions déjà découvertes et permises.

## 2. Activer

```yaml
staticAnalysis: { enabled: true, source: { root: ../mon-application } } # recommandé : le code suggère
openapi: { enabled: true, source: ./openapi.yaml } # recommandé : le contrat
rules: { enabled: true } # facultatif : objectifs RULE / PERMISSION
safety: { allowedActionClasses: [SAFE, MUTATION] } # sinon les objectifs d'écriture restent BLOCKED
functionalIntelligence:
  enabled: true # faux par défaut : comportement d'avant, à l'identique
  stateMachines: { enabled: true }
  invariants: { enabled: true }
  workflows: { enabled: true }
  sideEffects: { enabled: true }
  errorPaths: { enabled: true }
  runtimeContracts: { enabled: true }
  testGoals:
    enabled: true # faux : aucun objectif, aucun signal pour le moteur de décision
    influenceDecisionEngine: true
    decisionWeight: 1
    budgets: { maxGoalsPerRun: 50, maxGoalActions: 20, maxGoalDurationMs: 60000 }
```

Chaque partie se coupe seule. Sans analyse statique, seuls le contrat et le RuleGraph nourrissent l'intelligence fonctionnelle.

## 3. Ce que le code suggère (analyse statique, un seul passage sur l'AST)

| Fait lu                                                     | Exemple                                                                                                  | Sert à                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| énumération / union de littéraux nommée `…Status`, `…State` | `enum RegistrationStatus { DRAFT, PENDING, … }`                                                          | les états d'une entité                               |
| écriture HTTP et ses littéraux                              | `http.patch('/api/registrations/' + id, { status: 'APPROVED' })`                                         | une transition (état d'arrivée, API)                 |
| qui appelle l'écriture                                      | `RegistrationDetailComponent.approve` → `RegistrationService.approve`                                    | le workflow, le bouton déclencheur                   |
| garde qui sort                                              | `if (this.registration.status !== 'PENDING') return;`                                                    | l'état de départ ; un invariant d'état               |
| garde qui refuse                                            | `if (paid + amount > total) throw …`                                                                     | l'invariant `paid + amount <= total`                 |
| bouton et sa condition d'affichage                          | `@if (status === 'PENDING') { <button (click)="approve()">Approve`                                       | le libellé du déclencheur ; transitions non offertes |
| gestionnaire d'erreur                                       | `error: (e) => { if (e.status === 409 && e.error?.code === 'EMAIL_ALREADY_EXISTS') email.setErrors(…) }` | le chemin d'erreur jusqu'au champ                    |

Le contrat OpenAPI existant (`ApiContract`) ajoute les énumérations de statut, les champs obligatoires, les réponses d'erreur déclarées et, désormais, le schéma des réponses.

## 4. Les connaissances

### Machines à états métier (`BusinessStateMachineAnalyzer`)

Un **état métier** (PENDING) n'est pas un état d'écran : il est observé **sur** un écran (badge, statut affiché). Une transition `REGISTRATION:PENDING>APPROVED:approve` porte son déclencheur (`approve`, bouton « Approve »), son API, ses pré- et post-conditions (`RuleCondition` / `RuleEffect` du RuleGraph) et ses preuves.

| Statut                 | Signification                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| `STATIC_DISCOVERED`    | lue dans le code ou le contrat                                              |
| `RUNTIME_OBSERVED`     | un changement d'état vu à l'écran que le code ne décrivait pas              |
| `RUNTIME_CONFIRMED`    | le déclencheur a été exécuté : état de départ avant, état d'arrivée après   |
| `RUNTIME_CONTRADICTED` | API acceptée, mais l'écran montre toujours autre chose que l'état attendu   |
| `INCONCLUSIVE`         | l'écran ne permet pas d'en juger (liste avec plusieurs statuts, refus 4xx…) |

Seul un écran qui montre **un** état de l'entité avant et après est jugé (un écran de détail). Plusieurs transitions partagent souvent une route (`PATCH /api/registrations/{id}`) : l'action est rattachée par le libellé du bouton, sinon par l'**empreinte salée** de l'état écrit dans le corps — la valeur n'est jamais lue en clair. Les **transitions non offertes** (bouton absent dans un état) sont apprises statiquement et confirmées à l'écran ; elles ne sont **jamais forcées**.

### Workflows (`WorkflowIntentAnalyzer`)

Signature stable `VERBE:ENTITÉ` (`CREATE:USER`, `APPROVE:REGISTRATION`) : étapes (ouvrir la route, remplir le formulaire, cliquer, appel d'API), préconditions, résultats attendus, preuves (code, flows déclarés). Statuts : DISCOVERED, PARTIALLY_VERIFIED, VERIFIED, FAILED (5xx, ou état attendu non affiché), INCONCLUSIVE (refus métier 4xx, aucun appel vu).

### Invariants (`InvariantAnalyzer`)

Portées FIELD, FORM, ENTITY, WORKFLOW, API. Sources : gardes (comparaison inversée), gardes d'état (transition), règles REQUIRED conditionnelles et calculs du RuleGraph, champs obligatoires du contrat. Plusieurs champs dans une assertion : **contrainte croisée**. Un **index** par champ et par transition limite la vérification aux invariants qu'une action touche. Les valeurs ne sont jamais lues : un invariant numérique reste NOT_VERIFIED ; un invariant d'état est RUNTIME_CONFIRMED (transition depuis l'état exigé, déclencheur absent ailleurs) ou RUNTIME_VIOLATED (transition depuis un autre état).

### Effets secondaires (`SideEffectAnalyzer`)

Par workflow : API, STATE_CHANGE (nouvel état), UI (le déclencheur disparaît), ENTITY (créée : 201 ou identifiant rendu ; supprimée). Après l'action : CONFIRMED, MISSING, INCONCLUSIVE ; une écriture que rien n'annonçait est UNEXPECTED.

### Chemins d'erreur (`ErrorPathAnalyzer`)

`ACTION → ERREUR D'API → code métier → traitement → MESSAGE → CHAMP`. Classes : 400 VALIDATION, 401 AUTHENTICATION, 403 AUTHORIZATION, 404 NOT_FOUND, 409 CONFLICT, 422 BUSINESS_VALIDATION, 5xx TECHNICAL — une hypothèse : le vrai contrat est **observé** (statut, code en capitales lu dans la réponse — jamais un message libre —, champ marqué invalide, alerte affichée). RUNTIME_CONFIRMED quand la chaîne observée rejoint celle du code.

### Contrat au runtime (`RuntimeContractCorrelator`)

Le contrat existant comparé aux corps réels (clés et types ; énumérations par empreinte) : FIELD_NOT_SENT (le champ est à l'écran mais pas dans la requête), UNEXPECTED_FIELD, TYPE_MISMATCH, REQUIRED_FIELD_MISSING, ENUM_MISMATCH, NULLABILITY_MISMATCH, UNEXPECTED_STATUS_CODE, RESPONSE_SCHEMA_MISMATCH. Toujours **CONTRACT_MISMATCH**, jamais un bug de l'application : le contrat peut être obsolète.

## 5. Objectifs de test

`TestGoalGenerator` transforme la connaissance en objectifs : RULE, STATE_TRANSITION (« Verify PENDING registration can transition to APPROVED »), INVARIANT, WORKFLOW, SIDE_EFFECT (après un effet manquant), ERROR_PATH, CONTRACT, PERMISSION. Chacun dit **d'où il vient** (`generatedFrom`, `sourceId`, preuves) et **pourquoi** (`reason`), est dédupliqué par signature, et porte priorité, coût estimé, risque.

| Statut         | Signification                                                                         |
| -------------- | ------------------------------------------------------------------------------------- |
| `CANDIDATE`    | généré, pas encore planifié                                                           |
| `PLANNED`      | un plan existe (voir ci-dessous)                                                      |
| `RUNNING`      | son déclencheur vient d'être choisi (`TEST_GOAL_SELECTED`, raison TEST_GOAL_PROGRESS) |
| `VERIFIED`     | la connaissance dont il vient est confirmée au runtime                                |
| `FAILED`       | contredite (transition manquante, contrat non respecté, invariant violé)              |
| `BLOCKED`      | la SafetyPolicy refuse son action (supprimer, payer, modification non permise)        |
| `INCONCLUSIVE` | budget épuisé, refus métier, écran ambigu                                             |

La **SafetyPolicy décide** : l'action déclencheuse est jugée par `classify()` + `evaluate()` comme toute action découverte ; un objectif BLOCKED n'est jamais exécuté ni favorisé. Aucune transaction financière, aucune suppression n'est faite pour un objectif.

**Planification** (`TestGoalPlanner`, léger, il ne parcourt rien) : 1. l'écran courant satisfait déjà la précondition (une valeur déjà en place est gardée : BUSINESS reste BUSINESS, jamais BUSINESS → PERSONAL → BUSINESS) ; 2. chemin confirmé du FlowGraph ; 3. chemin historique (un indice, jamais une preuve) ; 4. route candidate du code ; 5. exploration bornée.

**Score** (`goal-scoring.ts`, un seul endroit) : priorité = gain de couverture × importance × confiance ÷ coût, moins le risque ; le moteur de décision reçoit un facteur `functional` de plus dans le `ScoreBreakdown` existant (progression d'objectif, couverture de transitions, d'invariants, de workflows), à côté de `rules`. Le moteur n'est pas remplacé ; la SafetyPolicy reste hors du score.

## 6. Oracle sémantique

`SemanticFunctionalOracle` (le point d'extension `SemanticOracle`, enfin branché dans le `CompositeTestOracle`) lit les constats de l'action : EXPECTED_SIDE_EFFECT_MISSING, EXPECTED_STATE_TRANSITION_MISSING, EXPECTED_ENTITY_NOT_OBSERVED, INVARIANT_VIOLATED, CONTRACT_MISMATCH. Au plus **WARNING** : anomalie `FUNCTIONAL` (ou `CONTRACT` pour un écart de contrat), jamais un échec confirmé à elle seule. Les étapes de flow, qui ne passent pas par les oracles, reçoivent les mêmes avertissements.

## 7. Couverture, historique, rapport, événements

- **Couverture fonctionnelle** : règles, états observés, transitions, invariants, workflows, effets, chemins d'erreur, écritures comparées au contrat — des **décomptes**, jamais une note.
- **Historique** : `knowledge/functional/functional-<clé>.json` (par application et environnement), à côté de `knowledge/rules/`. Une transition confirmée par un run précédent reste STATIC_DISCOVERED (affichée « earlier run ») tant que ce run ne l'a pas observée ; elle sert à planifier. Aucune valeur saisie, aucun SQL dans les analyseurs, le moteur ou l'oracle ; la mémoire de travail reste en RAM.
- **Rapport** : section « Functional intelligence » (machines à états, transitions non offertes, workflows, invariants, effets, chemins d'erreur, observations de contrat, objectifs avec leur plan ou leur issue, couverture). `result.json` : `functional`.
- **Journal du moteur** : `BUSINESS_STATE_DISCOVERED`, `BUSINESS_TRANSITION_DISCOVERED` / `CONFIRMED`, `INVARIANT_DISCOVERED` / `CONFIRMED` / `VIOLATED`, `WORKFLOW_DISCOVERED`, `SIDE_EFFECT_EXPECTED` / `CONFIRMED` / `MISSING`, `ERROR_PATH_DISCOVERED`, `CONTRACT_RUNTIME_MISMATCH`, `TEST_GOAL_GENERATED` / `SELECTED` / `STARTED` / `PROGRESS` / `VERIFIED` / `FAILED` / `BLOCKED` / `INCONCLUSIVE`.

## 8. Confidentialité et performance

- Corps de requête et de réponse : seulement leur **forme** (clés de premier niveau, types) ; une chaîne courte en empreinte salée par run ; un code d'erreur seulement s'il est un identifiant en capitales. Lu uniquement quand l'intelligence fonctionnelle est activée, sur les hôtes autorisés.
- Incrémental : chaque action ne revoit que les transitions déclenchées, les workflows réalisés, les invariants indexés par ses champs et ses transitions, les opérations de contrat appelées. Plafonds : 300 invariants, 200 chemins d'erreur et observations de contrat, `maxGoalsPerRun` objectifs (les autres sont comptés comme reportés).

## 9. Limites

- Machines à états : un champ d'état par entité (`status`, `state`…), états affichés tels que codés (`PENDING`), pas de libellés traduits.
- Workflows rattachés au premier composant appelant ; un service appelé par plusieurs écrans n'en garde qu'un.
- Invariants numériques jamais vérifiés à partir de valeurs (elles ne sont pas lues).
- Les objectifs ne déclenchent rien seuls : ils orientent le moteur de décision vers des actions déjà découvertes et permises.

# État des formulaires, dépendances et règles de l'application

QA-CRAWLER ne se contente plus de découvrir des écrans et des actions : il construit un **modèle explicable du comportement fonctionnel** — l'état de chaque champ, pourquoi sa valeur est là, ce qui dépend de quoi, et les règles que le code annonce, confirmées ou contredites par le navigateur.

```
CODE SOURCE + SOURCE MAPS + DOM + RÉSEAU + OPENAPI + EXÉCUTION
        ↓
ÉTAT DES CHAMPS · PROVENANCE · DÉPENDANCES · RÈGLES
        ↓
VÉRIFICATION PLAYWRIGHT (sûre, bornée, rétablie)
```

**Principe absolu :** `STATIC_DISCOVERED ≠ RUNTIME_CONFIRMED`. Le code donne des règles **candidates** ; seul le runtime les confirme (`RUNTIME_CONFIRMED`), les contredit (`RUNTIME_CONTRADICTED`) ou n'y parvient pas (`INCONCLUSIVE`, `BLOCKED_BY_POLICY`, `BLOCKED_BY_CONTEXT`). Une contradiction n'est jamais un bug en soi : les oracles existants en jugent.

## Ce qui a été ajouté (et ce qui est réutilisé)

Rien n'est réimplémenté : l'analyse statique existante (même parseur TypeScript, même passage sur l'AST, même cache), le SemanticResolver, l'UIObserver, le moteur de décision, la SafetyPolicy et la KnowledgeBase sont réutilisés.

| Nouveau                                                                               | Rôle                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forms/state/field-state.ts` — `FieldState`, `decideFieldAction`                      | états EMPTY / PREFILLED / DEFAULT_VALUE / AUTOFILLED / DERIVED_VALUE / PREVIOUS_STEP_VALUE / UNKNOWN_PREFILLED, décision FILL / KEEP / REPLACE / CLEAR / OBSERVE_ONLY / SKIP_* |
| `forms/state/form-state-analyzer.ts` — `FormStateAnalyzer`, `ValueProvenanceAnalyzer` | l'état de chaque champ et **pourquoi** sa valeur est là                                                                                                                        |
| `forms/state/value-digest.ts`, `value-sources.ts`                                     | empreintes salées des valeurs, réponses JSON indexées en empreintes, saisies du crawler                                                                                        |
| `forms/state/field-dependencies.ts` — `FormStateDiff`, `FieldDependencyGraph`         | avant / après une saisie → dépendances (visibilité, activation, valeur, options, validation, calcul, réseau)                                                                   |
| `static-analysis/rules/*` — `RuleCandidateExtractor`, `RuleAnalyzer`                  | règles candidates des gabarits (@if, [disabled]…) et du code (if, valueChanges, validateurs…)                                                                                  |
| `rules/rule-graph.ts` — `RuleGraph`, `RuleCoverage`, `RuleCoverageOpportunity`        | règles indexées (champ, composant, API), statuts, couverture, opportunités                                                                                                     |
| `rules/runtime-rule-verifier.ts` — `RuntimeRuleVerifier`                              | vérification passive puis active (valeur posée, observée, **rétablie**)                                                                                                        |
| `rules/form-rule-coordinator.ts`                                                      | orchestration par écran, signal pour le moteur de décision, résumé du rapport                                                                                                  |
| `knowledge/rule-knowledge-store.ts`                                                   | mémoire des règles par signature et par version (jamais une preuve)                                                                                                            |

## Partie A — État d'un champ et décision

Un champ n'est plus « vide ou rempli ». Par défaut, en exploration :

| État                                          | Décision      |
| --------------------------------------------- | ------------- |
| EMPTY                                         | FILL          |
| PREFILLED / DEFAULT_VALUE / AUTOFILLED valide | KEEP          |
| … invalide (ng-invalid, aria-invalid)         | REPLACE       |
| DERIVED_VALUE, lecture seule                  | OBSERVE_ONLY  |
| désactivé                                     | SKIP_DISABLED |
| sensible, refusé par la SafetyPolicy          | SKIP_UNSAFE   |

Une valeur **imposée par le scénario** reste prioritaire : `Et je sélectionne "France" comme pays` sur un pays déjà « Canada » donne `REPLACE (EXPLICIT_SCENARIO_VALUE)`, affiché dans l'interprétation de l'étape. La logique « s'il y a une valeur, l'ignorer » est supprimée ; une liste préremplie n'est plus remise à sa première option par l'exploration.

`forms.preserveExistingValues: false` remplace toujours les valeurs présentes par des données de test.

## Partie B — Provenance d'une valeur

`FORM_DEFAULT`, `SERVER_PREFILLED`, `PROFILE_PREFILLED`, `API_RESPONSE`, `BROWSER_AUTOFILL`, `PREVIOUS_STEP`, `DERIVED`, `USER_ACTION`, `STATIC_INITIALIZER`, `HISTORICAL`, `UNKNOWN`, avec confiance et preuves.

- **Code** (même passage sur l'AST que l'analyse existante) : `country: ['CA']` → FORM_DEFAULT ; `country: ['']` → vide ; `this.form.patchValue({ email: profile.email })` dans le `subscribe` de `getProfile()` → `GET /api/profile → email` (API_RESPONSE_TO_FIELD) ; `setValue(quantity * price)` → DERIVED.
- **Runtime** : une réponse JSON dont une valeur a la même empreinte que le champ → API_RESPONSE (PROFILE_PREFILLED pour /profile, /me, /account…) ; `:autofill` → BROWSER_AUTOFILL ; attribut `value` du HTML reçu → SERVER_PREFILLED ; valeur saisie par le crawler à une étape précédente → PREVIOUS_STEP.

**Aucune valeur n'est lue en clair.** Le navigateur ne rend qu'une empreinte salée (sel aléatoire par run, jamais écrit), le code et le libellé de l'option choisie d'une liste, l'état coché d'une case. Les réponses JSON sont réduites en empreintes puis oubliées. Rien de tout cela n'apparaît dans le rapport, `result.json` ou le journal.

## Parties C / D — Dépendances entre champs

```
avant la saisie → saisie → après la saisie → FormStateDiff → dépendances
```

Comparés : champs apparus / disparus, activés / désactivés, lecture seule, obligatoires (attribut, aria-required, ou champ vide marqué `ng-invalid` — Angular ne pose pas d'attribut), valeurs (empreintes), options, requêtes XHR/fetch.

`VISIBILITY_DEPENDENCY`, `ENABLEMENT_DEPENDENCY`, `VALUE_DEPENDENCY`, `OPTIONS_DEPENDENCY`, `VALIDATION_DEPENDENCY`, `DERIVATION_DEPENDENCY`, `NETWORK_DEPENDENCY` — chacune `STATIC` (lue dans une règle), `RUNTIME` (observée) ou `BOTH`. Le FieldDependencyGraph dit **quoi dépend de quoi** ; le RuleGraph dit **pourquoi et sous quelle condition** ; ils se référencent (`edge.ruleIds`, `rule.dependencyEdges`) sans dupliquer une relation.

## Parties D à F — Règles

```
RuleCandidateExtractor → RuleAnalyzer → RuleGraph → RuntimeRuleVerifier → RuleCoverage
```

- **Gabarits** : `@if` / `@else if` / `@else`, `@switch` / `@case` / `@default`, `*ngIf`, `[ngSwitch]` / `*ngSwitchCase`, `[hidden]`, `[class.hidden]`, `[disabled]`, `[readonly]`, `[required]`, `*ngFor` / `@for` des options, `routerLink` sous condition.
- **Code** : `if` / `else` dont une branche produit un effet fonctionnel — `addValidators` / `setValidators` / `clearValidators` / `removeValidators`, `enable()` / `disable()`, `setValue` / `patchValue`, `router.navigate`, affectation d'un littéral ou d'un calcul, appel d'API, propriété d'une requête ; `X.valueChanges.subscribe(...)` (déclencheur) ; une méthode de la classe appelée depuis un déclencheur est suivie (un niveau).
- **Conditions** : `==`, `!=`, `<`, `<=`, `>`, `>=`, ET, OU, NON, `form.valid` / `form.invalid`, drapeau, rôle (`hasRole('ADMIN')`, `role === 'ADMIN'`, `roles.includes(…)`), valeur d'enum. Le reste est `OPAQUE` : cité, jamais interprété. Aucun moteur logique général.
- **Pas une règle** : `if (!response) return;` — aucune conséquence fonctionnelle (compté comme condition technique).
- **Effets** : SHOW, HIDE, ENABLE, DISABLE, READONLY, EDITABLE, REQUIRED, OPTIONAL, ADD_VALIDATOR, SET_VALUE, CALCULATE_VALUE, SET_OPTIONS, ALLOW/DENY_NAVIGATION, ALLOW/DENY_ACTION, API_REQUEST_EXPECTED, INCLUDE_IN_REQUEST.
- **Catégories** : BUSINESS, VISIBILITY, ENABLEMENT, READONLY, VALIDATION, CALCULATION, NAVIGATION, PERMISSION, OPTIONS.
- Le `@if` du gabarit et le `addValidators` du code sur la même condition font **une** règle (`ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER` : visible, visible, obligatoire, envoyé dans `POST /api/accounts`).
- **Signature** stable : catégorie + sémantique des conditions + sémantique des effets + identité des cibles + composant — jamais un numéro de ligne, un nom minifié ou un id généré du DOM.

## Partie G — Vérification au runtime

- **Passive** : l'écran tel qu'il est. Un compte déjà `BUSINESS` (prérempli par le profil) montre déjà ses champs : la règle est confirmée **sans modifier** le type de compte. Vérifier une règle ne veut pas dire modifier un champ.
- **Active** : poser la valeur qui réalise la condition (`country = FR`, `age = 9`, `quantity = 2`), observer, puis **rétablir** la valeur d'origine. Seulement si : la SafetyPolicy permet de changer ce champ, il n'est pas sensible, sa valeur d'origine est connue (option, case, champ vide, valeur par défaut du code), et **jamais** un champ prérempli par le serveur ou un profil. Budgets : `rules.budgets.maxRuntimeVerifications`, `maxDurationMs`, `forms.dependencyDiscovery.maxFieldMutations`, `maxValuesPerField`.
- **Liaisons du gabarit** (`@if`, `[disabled]`) : vérifiées dans les deux sens (PERSONAL → `companyNumber` absent). Un validateur du code ne se défait pas seul : seul le sens « condition vraie » est vérifié.
- **Jamais forcé** : aucun envoi de formulaire, aucun rôle changé. Une règle de rôle reste `BLOCKED_BY_CONTEXT` ; une règle qui aurait besoin d'un envoi interdit reste `BLOCKED_BY_POLICY`.
- **Contradiction** : `RUNTIME_CONTRADICTED` avec son contexte (route, version, état du formulaire), jamais `CONFIRMED_BUG`.

## Partie H — Couverture et moteur de décision

`RuleCoverage` : découvertes, confirmées, contredites, en partie vérifiées, non vérifiées, bloquées (politique / contexte), non concluantes — et « vérifiées / découvertes », un **constat**, jamais un verdict de qualité.

Le moteur de décision existant reçoit un signal de plus, `rules` dans le ScoreBreakdown :

```
score = base + objectif + motif + nouveauté + historique + couverture + ruleCoverageOpportunity − risque − répétition
```

Une liste dont une valeur vérifierait trois attentes non couvertes (`accountType = BUSINESS` → companyName visible, companyNumber visible, companyNumber obligatoire) gagne des points, et reçoit cette valeur quand elle est exécutée (`RULE_COVERAGE_OPPORTUNITY … ACTION SELECTED … reason RULE_COVERAGE`). La SafetyPolicy reste **hors du score** et absolue. Le but : un minimum d'interactions sûres pour un maximum de règles vérifiées, pas un maximum de combinaisons.

## Partie I — Mémoire, rapport, événements

- **KnowledgeBase** (`knowledge/rules/`) : statut, confirmations, contradictions de chaque règle par signature, avec version, commit, environnement. **L'historique n'est jamais une preuve** : une règle confirmée sur une autre version s'affiche « not current — needs a new confirmation » et reste STATIC_DISCOVERED tant que le runtime courant ne l'a pas revue.
- **Rapport** : sections « Form state » (champ, état, origine, source, décision, pourquoi), « Application rules » (couverture, chaque règle : catégorie, condition, effets ✓/✗/?, source statique fichier:ligne, runtime, effet réseau, confiance, contexte d'une contradiction, historique), « Rule graph », « Field dependencies ». `result.json` : `formRules`.
- **Événements** : `RULE_DISCOVERED`, `RULE_CLASSIFIED`, `RULE_VERIFICATION_STARTED`, `RULE_RUNTIME_CONFIRMED`, `RULE_RUNTIME_CONTRADICTED`, `RULE_VERIFICATION_INCONCLUSIVE`, `RULE_BLOCKED_BY_POLICY`, `RULE_COVERAGE_UPDATED`, `RULE_COVERAGE_OPPORTUNITY`, `FIELD_DEPENDENCY_DISCOVERED`.

## Configuration

```yaml
forms:
  preserveExistingValues: true # KEEP une valeur présente et valide
  dependencyDiscovery:
    enabled: true # dépendances observées lors des saisies du crawler
    maxFieldMutations: 10 # champs sans règle dont les effets sont observés (avec rules.runtimeVerification)
    maxValuesPerField: 3
    maxDurationMs: 15000
staticAnalysis:
  enabled: true # les règles se lisent dans le code (dépôt ou source maps)
  source: { root: ../mon-application }
rules:
  enabled: true # désactivé par défaut
  staticDiscovery: true
  runtimeVerification: true
  influenceDecisionEngine: true
  decisionWeight: 1
  categories:
    {
      business: true,
      visibility: true,
      enablement: true,
      readonly: true,
      validation: true,
      calculation: true,
      navigation: true,
      permission: true,
      options: true,
    }
  budgets: { maxRulesPerPage: 100, maxRuntimeVerifications: 20, maxDurationMs: 30000 }
```

L'état des champs et les décisions KEEP / REPLACE s'appliquent toujours ; les règles et la vérification active seulement avec `rules.enabled`.

## Performance

La décision interroge des **index** (champ → règles, composant → règles, API → règles), jamais l'AST : 10 000 recherches d'opportunité sur 1 000 règles en bien moins d'une seconde (`tests/unit/rules.test.ts`). L'extraction se fait pendant l'analyse statique existante et se met en cache avec elle (version de l'analyseur 1.1.0).

## Limites

- Angular (gabarits et code) et TypeScript générique ; un niveau de méthode suivi depuis un déclencheur.
- Un état interne du composant (`mode === 'EDIT'`, `loading`) ne se lit pas à l'écran : la règle reste NOT_VERIFIED (jamais devinée).
- Une valeur lue (pas saisie par le crawler) n'est jamais comparée à un nombre : les conditions `>` / `<` ne se vérifient qu'avec une valeur posée par le crawler.
- Les listes personnalisées (mat-select) sont observées, pas changées par la vérification active.

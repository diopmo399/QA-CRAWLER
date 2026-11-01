# Audit d'architecture : AI-Powered Incident Reconstruction

Date : 2026-10-31. Lecture seule de l'arbre de travail (modifications non commitées comprises : `git status`
liste 43 fichiers modifiés et 17 nouveaux, dont `src/incident/live.ts`, `attachments.ts`, `report-export.ts`,
`scope-tree.ts`, `src/sdk/ui/incident-split.ts`). Les numéros de ligne sont ceux de cet arbre.

Objet : poser un orchestrateur d'investigation multi-agents (modes `DETERMINISTIC` / `AI_ASSISTED` /
`AI_AGENTIC`) **au-dessus** du moteur déterministe d'Incident Reconstruction, sans le remplacer, en
réutilisant ce que `src/ai/` offre déjà et en bornant tout par le Scope Policy Engine.

## 0. Verdict et décisions recommandées

1. **Le moteur déterministe reste l'autorité.** `diagnose()` (`src/incident/root-cause.ts:80-152`) et la règle
   `meetsConfirmation()` (`src/incident/hypotheses.ts:783-794`) ne changent pas : une hypothèse produite par un
   modèle naît `PROPOSED`, confiance plafonnée à `MAX_CONFIDENCE_WITHOUT_EXPERIMENT` (0,7), et seule
   `applyExperiment()` (`hypotheses.ts:795-833`) peut la faire monter. Le modèle ne pose jamais `CONFIRMED`.
2. **Un nouveau module `src/incident/ai/`**, séparé de `src/ai/` (qui est l'assistant de raisonnement du rejeu :
   requête « actions A1…An », proposition d'action, arbitrage avec la SafetyPolicy). On en reprend le
   nettoyage, le budget, l'audit, l'extraction JSON, le chargement dynamique des SDK et la philosophie « repli
   déterministe », pas le contrat de requête ni la passerelle `consult()`.
3. **Le mode `DETERMINISTIC` est strictement le comportement actuel** : aucun objet créé, aucun fournisseur
   chargé, aucun événement, mêmes fichiers écrits (reprendre `effectiveMode()` de `src/ai/factory.ts:46-48`).
4. **Les outils du modèle sont une liste fermée, typée, en lecture seule**, dont chaque appel se traduit en
   `PolicyOperation` (`src/sdk/core/incident-contracts.ts:282-290`) vérifiée par `ScopePolicy.check()`
   (`src/incident/scope-policy.ts:367-381`). Deux exceptions « d'écriture » seulement, et seulement vers des
   états d'attente : `planExperiment()` (statut `PROPOSED` / `APPROVAL_REQUIRED`, `src/incident/experiments.ts:57-76`)
   et `requestExtension()` (statut `PENDING`, `src/incident/scope.ts:519`). Jamais `runExperiment`, jamais
   `decideExtension`, jamais `ALLOW_SIDE_EFFECTS`.
5. **Le contrat navigateur reste dans `src/sdk/core/`** (test `tests/unit/sdk-contract.test.ts:157-175`) : les
   nouveaux types vont dans `src/sdk/core/incident-ai-contracts.ts`, ré-exporté d'une ligne par
   `incident-contracts.ts`, et `Investigation` gagne un champ facultatif `ai`.
6. **Dans l'espace d'investigation, un sous-onglet « Investigation IA » de l'onglet Diagnostic** (disposition
   `document`, pleine largeur sans sélection), pas un septième onglet principal ni une onzième étape de la
   progression. Les hypothèses d'origine IA portent une puce d'origine dans « Hypothèses ».
7. **Points bloquants à lever avant d'écrire la première ligne d'agent** (détail § 8) :
   - aucune configuration `ai` n'atteint le serveur SDK ni `IncidentService` (`src/sdk/server/server.ts:3520`
     passe seulement `env`) ;
   - le shim du SDK Anthropic (`src/ai/anthropic/sdk.ts:198-227`) ne type ni `tools`, ni `tool_use`, ni
     `tool_result` : pas de boucle d'outils possible sans l'étendre (à vérifier contre `@anthropic-ai/sdk`
     0.131.0, `package.json:64`) ;
   - aucune recherche textuelle dans le code du périmètre n'existe (`analyzeCode` indexe, `service.source()` lit
     un fichier entier) : un outil `search_code` borné est à écrire ;
   - `Investigation`, `IncidentEvent.kind` et `Hypothesis` n'ont aucun emplacement pour l'IA.

## 1. La couche `src/ai/` : ce qu'elle fait vraiment

### 1.1 Contrat de fournisseur

- `IntelligenceProvider` (`src/ai/provider.ts:20-32`) : `id`, `model?`, `isAvailable()`, `unavailableReason?()`,
  `analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult>`,
  `modelSummary?()`, `close?()`. **Un seul tour** : une requête structurée, une réponse brute.
- `IntelligenceRequest` (`src/ai/model.ts:137-172`) est le contexte d'un **rejeu** : `trigger` (parmi
  `INTELLIGENCE_TRIGGERS`, lignes 18-37), `availableActions` (identifiants `A1…`), `constraints.allowedActionIds`,
  `functionalContext`, `recordingContext`, `targetResolution`. Rien d'un incident (requêtes HTTP, code, graphe).
- `ProviderResult` (`model.ts:351-359`) : `raw: unknown`, `model?`, `toolCalls?`, `usage?: { inputTokens, outputTokens }`,
  `modelContext?`. `ProviderCallOptions` (`model.ts:362-371`) : `signal: AbortSignal`, `complexity?`, `emit?`,
  `tools?: IntelligenceToolContext`, `maxToolCalls`.
- La proposition (`intelligenceProposalSchema`, `model.ts:204-275`, et son JSON Schema `INTELLIGENCE_PROPOSAL_JSON_SCHEMA`
  278-348) est celle d'un choix d'action (`selectedActionId`, `plan.steps`, `expectedEffects`). Elle porte un
  motif réutilisable : `supportingEvidenceIds`, `uncertainties`, `confidence`, `confidenceBreakdown`, `status`
  `PROPOSAL | INCONCLUSIVE | NEED_MORE_EVIDENCE`.

### 1.2 Passerelle, budget, validation, audit

- `IntelligenceGateway.consult()` (`src/ai/gateway.ts:198-485`) enchaîne : complexité sans LLM → `budget.check(scope)`
  → `sanitizer.sanitize(request)` → disponibilité du fournisseur → boucle de `maxRetries` tentatives sous
  `withTimeout()` (624-638, `AbortController` + `Promise.race`) → `validateIntelligenceProposal()` → `arbitrate()`
  → `audit.create()`. Le délai effectif est `min(timeoutMs, budgets.maxReasoningDurationMs, deadline limitTo())`
  (280-287). Les erreurs sont nettoyées par `sanitizeText` avant d'être consignées (326, 640-642).
- `IntelligenceBudgetManager` (`src/ai/budget-manager.ts:206-262`) : compteurs par run / action / divergence,
  `check()` → raison ou `undefined`, `begin()`, `end({ latencyMs, toolCalls, timeout, usage })` ; `BudgetUsage`
  (190-199) additionne `inputTokens` / `outputTokens`. **Aucun plafond en jetons ni en coût**, aucune table de prix.
- `validateIntelligenceProposal()` (`src/ai/proposal-validator.ts:48-131`) : schéma strict puis « réalité » (actions
  connues, autorisées, non désactivées ; preuves citées existantes via `knownEvidence(id)` ; proposition non
  vide). `validateEvidence()` (30-37) est directement réutilisable comme principe : **une référence inventée fait
  rejeter la réponse**.
- `IntelligenceAuditTrail` / `AiDecisionRecord` (`src/ai/audit-trail.ts:59-120`, limite 500 entrées, 221) : entrée
  résumée (comptes, `redactions`), proposition structurée, validation, décision, latence, `toolCalls`, modèle
  réellement utilisé. Jamais de chaîne de pensée. Vocabulaire d'événements `AI_EVENTS` (`gateway.ts:45-83`).
- Utilisateurs actuels : `src/explorer/flow-explorer.ts:1204` et `src/recording/record-orchestrator.ts:219` (CLI et
  moteur), **jamais le serveur SDK**.

### 1.3 Configuration `ai`

`aiSchema` (`src/config/config.ts:2015-2175`), `AiConfig = ScenarioConfig['ai']` (2540) :

| Champ                                                                       | Valeur / défaut                                                                                                                    | Ligne                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `enabled`                                                                   | `false`                                                                                                                            | 2017                               |
| `mode`                                                                      | `OFF` \| `ASSIST` \| `HYBRID`, défaut `OFF` ; `effectiveMode()` rend `OFF` si `enabled` est faux                                   | 2018 ; `factory.ts:46-48`          |
| `provider`                                                                  | `copilot` \| `anthropic` \| `deterministic`, défaut `copilot`                                                                      | 2020                               |
| `failOnUnavailable`                                                         | `false` (repli déterministe, événement `AI_UNAVAILABLE`)                                                                           | 2022                               |
| `copilot.timeoutMs` / `maxRetries` / `tools` / `tokenEnv` / `baseDirectory` | 30 000 / 1 / `true` / facultatif / `.qa-crawler/copilot`                                                                           | 2078-2084                          |
| `anthropic.model`                                                           | facultatif, **obligatoire pour ce fournisseur** (sinon indisponible)                                                               | 2092 ; `anthropic-provider.ts:139` |
| `anthropic.effort` / `maxTokens` / `timeoutMs` / `maxRetries`               | `high` / 16 000 / 120 000 / 1                                                                                                      | 2094-2097                          |
| `anthropic.serverSideFallback` / `apiKeyEnv` / `baseUrl`                    | `false` / facultatif (`ANTHROPIC_API_KEY` sinon) / facultatif                                                                      | 2099-2103                          |
| `triggers.*`, `thresholds.*`                                                | propres au rejeu                                                                                                                   | 2107-2135                          |
| `budgets`                                                                   | `maxCallsPerRun` 10, `maxCallsPerAction` 1, `maxCallsPerDivergence` 1, `maxToolCallsPerRequest` 6, `maxReasoningDurationMs` 60 000 | 2138-2146                          |
| `context`                                                                   | `maxActions` 25, `maxEvidence` 15, `maxHypotheses` 8, `sensitiveFields: []`                                                        | 2149-2157                          |
| `audit.enabled`                                                             | `true`                                                                                                                             | 2159-2161                          |

Surcharges CLI / environnement : `--ai-provider`, `--ai-model`, `--ai-model-selection`, `--ai-reasoning`
(`src/cli/args.ts:90-95, 158-161`), `QA_INTELLIGENCE_ENABLED` et les variables de mode / fournisseur
(`src/config/config-loader.ts:374-400`). **Aucun interrupteur de politique de données** (quelles catégories
peuvent quitter la machine) n'existe.

### 1.4 Les trois fournisseurs

| Capacité                  | `anthropic` (`src/ai/providers/anthropic-provider.ts`)                                                                                                   | `copilot` (`src/ai/providers/copilot-provider.ts`)                                                                                                                                                              | `deterministic` (`deterministic-provider.ts`) |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Complétion                | `client.beta.messages.create(body, { signal, timeout, maxRetries: 0 })`, un message `user` (93-118)                                                      | `session.sendAndWait({ prompt, responseSchema }, timeoutMs)` (376-397)                                                                                                                                          | règles lexicales, `model: 'rules'` (273-306)  |
| Sortie structurée         | `output_config.format: json_schema` après retrait des mots-clés non pris en charge (`structuredOutputSchema`, 53-61) ; revalidée par zod côté QA-CRAWLER | `responseSchema`, repli « schéma dans le message » si le runtime refuse (385-396)                                                                                                                               | objet typé                                    |
| Appel d'outils            | **non** (`toolCalls: 0`, 131) ; le shim ne type pas `tools` (`anthropic/sdk.ts:198-210`)                                                                 | **pris en charge**, via `CopilotToolRegistry.definitions()` (`copilot/tool-registry.ts:129-144`) : handlers, budget `allow()`, résultats nettoyés ; **la boucle d'outils est dans le SDK**, pas dans QA-CRAWLER | non                                           |
| Flux (streaming)          | non                                                                                                                                                      | non (événements `assistant.usage` seulement, 211-221)                                                                                                                                                           | non                                           |
| Sous-agents / multi-tours | non : « every request is self-contained » (`prompt-builder.ts:162`)                                                                                      | session réutilisable (`sessionReuse`) mais un tour par requête                                                                                                                                                  | non                                           |
| Annulation                | `signal` transmis au SDK (115)                                                                                                                           | `signal` → `session.abort()` (222-225)                                                                                                                                                                          | —                                             |
| Usage                     | `usage.input_tokens / output_tokens` (122-127)                                                                                                           | événements `assistant.usage`                                                                                                                                                                                    | —                                             |
| Refus                     | `stop_reason === 'refusal'` → `INCONCLUSIVE` ; `max_tokens` → `{ invalid }` (161-177)                                                                    | —                                                                                                                                                                                                               | —                                             |

Prompts : `QA_ADVISOR_SYSTEM_PROMPT` (`src/ai/copilot/prompt-builder.ts:152-185`, mis en cache côté fournisseur
Anthropic par `cache_control: ephemeral`, 101) et `buildUserPrompt()` (188-204) = « Trigger … » +
`JSON.stringify(request)` + « authoritative for this turn ». `extractJson()` (207-221) retrouve le premier objet
JSON d'un texte. Aucun délimiteur ni étiquette « contenu non fiable » : le contexte y est de l'état
structuré déjà résumé par le moteur, pas des textes bruts.

### 1.5 Secrets, masquage, journalisation

- `IntelligenceContextSanitizer` (`src/ai/sanitizer.ts:299-359`) : clés sensibles (`SENSITIVE_KEY`, 274-275) →
  `<PASSWORD_SECRET>` ; `sanitizeText` du redactor de persistance ; jetons GitHub, clés longues `sk-/pk-/rk-`,
  adresses électroniques ; valeurs secrètes connues et champs sensibles configurés. `sanitizeValue()` (354-359)
  passe un résultat d'outil par le même chemin.
- `secretValuesOf(env)` (`src/ai/factory.ts:51-58`) : toute variable dont le nom évoque un secret et dont la
  valeur fait au moins 6 caractères est retirée de ce qui part.
- Clés d'API : `apiKeyEnv` ou `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (présence vérifiée, jamais journalisée,
  `anthropic-provider.ts:138-143`) ; `tokenEnv` ou compte connecté pour `copilot` (`copilot/client-manager.ts:129`).
- Les SDK sont des dépendances **facultatives** chargées par import dynamique à spécificateur calculé
  (`anthropic/sdk.ts:241-248`, `copilot/sdk.ts:95-102`).
- Côté incident, le masquage est `redactText` / `redactUrl` (`src/security/redactor.ts:30, 39`) et `maskSource()`
  (`src/incident/service.ts:133`, clés `SECRET_KEY` ligne 127).

### 1.6 Tests disponibles

`tests/fixtures/fake-intelligence-provider.ts` (`FakeIntelligenceProvider`, réponse scriptée, `delayMs`,
`available`), faux SDK Anthropic (`tests/unit/ai-anthropic-provider.test.ts:50-80`, classe qui enregistre
clients et appels), `tests/unit/ai-intelligence.test.ts` (passerelle complète avec le faux fournisseur).

## 2. `src/incident/` : le moteur déterministe

### 2.1 Contrats partagés (`src/sdk/core/incident-contracts.ts`)

- États `INCIDENT_STATES` (22-34) ; transitions `INCIDENT_TRANSITIONS` (`src/incident/incident-store.ts:63-74`) :
  `INVESTIGATING → DIAGNOSED | INCONCLUSIVE | REPRODUCING | FAILED | CANCELLED`.
- `RELATION_STATUSES` (153), `HYPOTHESIS_STATUSES` (156-164 : `PROPOSED, INVESTIGATING, SUPPORTED, REFUTED,
INCONCLUSIVE, CONFIRMED`), `LAYERS` (166-176), `EVIDENCE_KINDS` (340-353, aucune sorte « IA »).
- `Hypothesis` (630-644) : `id`, `title`, `description`, `suspectedCause`, `layer`, `files`, `supporting[] / contradicting[]`
  de `{ ref, fact }`, `confidence`, `verifications: ProposedVerification[]`, `status`. **Aucun champ d'origine.**
  L'identifiant encode la règle (`hyp-<règle>`, `hypotheses.ts:222-236`, `ruleOf()` 46-50) et pilote
  `recommendationsFor()` (835-871 : une règle inconnue rend `[]`, donc un identifiant `hyp-ai-…` est inoffensif).
- `ProposedVerification` (624-628), `Experiment` (657-674 : `sideEffects`, `approvedBy`, `decisions: PolicyDecision[]`,
  `outcome SUPPORTS | REFUTES | NEUTRAL`), `EXPERIMENT_KINDS` (612-622), `Diagnosis` (676-684).
- `IncidentEvent.kind` (702-724) : liste fermée sans valeur IA. `Investigation` (726-738) : `reproductions, code?, graph?,
hypotheses, experiments, diagnosis?, regression?, frontendTrace?, timeline?`.
- `PolicyOperation` (282-290 : `READ_FILE, LIST_DIR, READ_LOG, NAVIGATE, HTTP, RUN_TEST, COMMAND, OPENSHIFT`),
  `PolicyDecision` (292-302, avec `extension?` suggérée en GUIDED), `ScopePermissions` (204-215), `ResourceLimits`
  (217-228), `SCOPE_EXTENSION_KINDS` (230-240), `InvestigationScope` (257-278).
- `CodeIndex` (552-562), `CodeSymbol` (501-514, id `${applicationId}:${file}#${name}`), `InvestigationGraph` (605-608),
  `SourceFileView` (982-998), `incidentReproduction()` (1017-1025).

### 2.2 Hypothèses, expériences, cause racine

- `proposeHypotheses({ incident, reproduction?, code?, graph? })` (`hypotheses.ts:607-763`) : neuf règles
  (`HYPOTHESIS_RULES`, 32-42), rien sans reproduction (616). Les références favorables sont des identifiants
  d'échange HTTP (`request.id`), de symbole (`symbol.id`) ou `experiment:<KIND>:<id>` (`EXPERIMENT_REF`, 769) ;
  exemple `nullRelation()` 270-352.
- `meetsConfirmation()` (783-794) : ≥ 2 expériences **de sortes différentes**, dont une de `DYNAMIC_EXPERIMENTS`
  (56-64), et aucune preuve contraire. `applyExperiment()` (795-833) est l'unique chemin vers `SUPPORTED` /
  `CONFIRMED` / `REFUTED`, à partir d'une expérience `DONE` reliée par `hypothesisId`.
- `diagnose()` (`root-cause.ts:80-152`) : `CONFIRMED` seulement si une hypothèse est `CONFIRMED` **et** satisfait
  encore `meetsConfirmation` (92-94) ; `PROBABLE` depuis `SUPPORTED` ; `missing` et `recommendations` fondés sur
  les hypothèses (`missingFor` 18-60, `confirmationGap` 63-78).
- `planExperiment()` (`experiments.ts:57-76`) ne lance rien ; `runExperiment()` (506-604) : `prepare()` → une
  décision de politique par opération (548-552) → effets de bord : `approvedBy` **et** `permissions.sideEffects`
  (555-563) → règles `INTEGRATION_TEST` hors production (566-576) → budget `policy.consume('experiment')` (579) →
  exécution bornée par `limits.maxDurationMs` (`boundedSignal`, 458) → preuves `EvidenceSink` masquées (273-295).
  `ExperimentContext` (31-41) : `incident, policy, adapter, files, code?, replay(), signal, actor, now`.
- `service.analyze()` (`service.ts:542-595`) est synchrone (attendu par la route) : `analyzeCode` si
  `permissions.readSources`, `buildGraph`, `proposeHypotheses`, puis `store.mutate` qui **garde les hypothèses non
  `PROPOSED` et ajoute les nouvelles par titre** (576-583). Cette fusion est le point d'ancrage naturel des
  hypothèses IA.

### 2.3 Périmètre, politique, fichiers, environnements

- `defaultScope()` (`scope.ts:74`), `DEFAULT_PERMISSIONS` (26, tout refusé sauf lecture des sources et
  navigation), `DEFAULT_LIMITS` / `LIMIT_CAPS` (37, 46), `validateScope()` (169), `requestExtension()` (519),
  `decideExtension()` (623), `automation(mode)` (644), `ALWAYS_REFUSED_COMMANDS` (452).
- `ScopePolicy` (`scope-policy.ts:336-406`) : `check()` consigne chaque décision dans `decisions`, `require()`
  lève `ScopeDeniedError` (22-30), `consume('file' | 'request' | 'experiment')`, `usage()`. Règles nommées :
  `path.absolute / invalid / missing / not-directory / not-file / sensitive / traversal`, `http.method`,
  `network.metadata`, `command.args / cwd / dangerous / invalid`, `test.args / level`, `log.in-scope`,
  `openshift.read / resource`, `internal.error`. Aides exportées : `isSensitivePath` (73), `forbiddenAddress` (139),
  `testInvocationProblem` (947), `dangerousCommand` (1083).
- `GuardedFiles` (`guarded-fs.ts:11-25`) et `guardedFiles(policy)` (59) : `readText` = `READ_FILE` + budget +
  `maxFileBytes` + lecture du `resolvedPath` ; `list`, `listDirectories` ; `denied` / `truncated` conservés.
  **C'est la seule porte vers le code** : tout outil `read_source` / `search_code` doit passer par elle.
- `ExecutionEnvironmentAdapter` (`environments.ts:53-67`) : `capabilities()`, `files(policy)`, `runTest(policy, op,
{ timeoutMs, signal })`, `readLogs(policy, source, { maxLines, signal })` ; `ProcessRunner` (33-39) simulable ;
  `boundedOutput` 16 000 caractères (88, 124) ; `environmentAdapter()` (475) ; manifeste de Job ARO (492).

### 2.4 Code, corrélation, preuves

- `analyzeCode(scope, files, { endpoints })` (`code/index.ts:28-123`) → symboles, endpoints, appels sortants,
  appels résolus, refus et limites. Analyseurs : `analyzeJavaSource()` (`code/java.ts:293`), `analyzeFrontendSource()`
  (`code/frontend.ts:76`), `resolveCalls()` (`code/resolve.ts:14`), `matchEndpoint()` (`code/paths.ts:63`),
  `readSpringProperties()` (`code/properties.ts:10`). **Aucune recherche de texte** ; `service.source()` (465-517) rend
  un fichier entier masqué avec `highlights`, `service.sourceTree()` (433) l'arborescence lisible.
- Corrélateur : `buildGraph({ incident, reproduction?, code?, depth })` (`correlator.ts:365`), `nullDereferenceIn`
  (173), `exceptionsIn` (147), `dereferencingSymbols` (200), `symbolOfClass` (209), `citedPaths` (733),
  `weakest()` des statuts (132).
- Preuves : `reproductionFromResult()` (`evidence.ts:126`), `symptomMatch()` (372), identifiants
  `${reproduction}:ev-issue-…`, `${id}:req-x-…` ; tout texte passe par `redactText` (45).

### 2.5 Service, suivi, persistance

- `IncidentHost` (`service.ts:85-110`) : `replay()`, `scenarioYaml()`, `addScenario()`, `environment()`, `runDir()`.
  `IncidentService` (170-196) : `deps { adapter?, now?, env?, pdf?, pdfTimeoutMs? }` ; `policy(incident)` (206-216)
  ajoute l'hôte de l'environnement cible.
- Travaux longs : `runExperiment()` (614-698) répond tout de suite après un `mutate` `RUNNING`, puis travaille en
  arrière-plan avec `AbortController`, `track(id, stop)` (1128-1135) et `keep(work)` (1137-1141) ; `cancel()`
  (1090-1094) appelle tous les `stop` de l'incident puis `store.cancel`. `settle()` (1101) attend tout (tests).
  La reproduction tient sa progression **en mémoire** (`live`, 182 ; `LiveProgress`, `live.ts:45-106`) pour ne pas
  changer la révision à chaque étape (commentaire 178-181) : un run IA long doit faire pareil.
- `IncidentStore.mutate()` (`incident-store.ts:464-493`) : exclusion mutuelle par fichier, clone, `revision + 1`,
  événement d'historique, interdiction de passer `CANCELLED` par ce chemin ; `transition()` (495-507).
- Rapport : `buildReport()` (`report.ts:150-198`) recopie `investigation.hypotheses` et `experiments` tels quels,
  `limitationsOf()` (78-148) cite les hypothèses non éprouvées et le diagnostic non confirmé ; `REPORT_SECTIONS` (contrats 107-118) sans
  section IA. `report-export.ts` (HTML, PDF), `regression.ts` (`proposeRegressionTest` 59), `attachments.ts`
  (types acceptés, `sniffAttachment` 115), `timeline.ts` (`buildTimeline` 349, recalculée à chaque lecture,
  `service.ts:223`).

## 3. Routes, droits, client, suivi

- `handleIncidentRoutes()` (`src/sdk/server/incidents.ts:47-241`) : `GET` liste / incident / `capabilities` / `sources`
  / `source` / `screenshot` / `report` / `scope/tree` / `regression/spec` ; `POST` `update`, `scope/validate`,
  `scope/extensions[/:id/decision]`, `reproduce` (202), `analyze`, `experiments` (201) et `experiments/:id/run`
  (202, 403 sans `RUN_WRITES` pour approuver des effets de bord, 203-216), `diagnose`, `regression[/run|accept|reject]`,
  `cancel`, `resume` ; pièces jointes (247-280). Traduction des erreurs (340-370 : `BUSY` → 409, `SCOPE` →
  403 `OUT_OF_SCOPE`, `ScopeDeniedError` → 403).
- Droits : `incidentRight()` (`src/sdk/server/access.ts:310-316`) : `RUN` par défaut, `DECIDE` pour décider une
  extension ou rejeter le test, `PUBLISH` pour l'accepter. Rôles (`src/sdk/core/contracts.ts:1982-1987`) :
  `READER` VIEW ; `ANALYST` VIEW, RUN, DECIDE ; `PILOT` + RUN_WRITES, PUBLISH ; `ADMIN` tout. Le serveur exige en plus
  `requireWrites()` pour ce qui joue l'application (`server.ts:3180-3193`).
- Câblage : `incidentService(ctx, project)` (`server.ts:3410-3522`) construit l'hôte et
  `new IncidentService(host, { env: ctx.env })` (3520). `ctx.env` est l'environnement du serveur
  (`SdkServerOptions.env`, 251) ; `envNames` (`/^QA_[A-Z0-9_]+$/`, 324) ne restreint que les variables qu'un
  **projet** peut référencer (541, 2796). La configuration moteur d'un projet est relue par `loadConfigFile()`
  (2447) — elle contient donc le schéma `ai`, mais le service d'incidents ne la lit jamais.
- Client : interface `incidents` (`src/sdk/core/client.ts:559-680`), implémentation (1175-1255), chemin
  `…/incidents/:id/<action>` (854-855). `reproduce` documente le suivi : « relire `get` jusqu'à ce que l'état
  change » (588). Le contrôleur relit toutes les `INCIDENT_POLL_MS` = 1 500 ms
  (`src/sdk/ui/incident-workspace-controller.ts:112`, `poll()` 748-787) et ne redessine que si `revision` ou
  l'empreinte du direct change. **Aucune annulation par opération**, aucun flux serveur : `cancel` arrête tout.
- Exports : `src/sdk/core/index.ts:22-46` ré-exporte les types d'`incident-contracts` ; la règle « rien de Node
  dans core/ui » est vérifiée par `tests/unit/sdk-contract.test.ts:157-175`.

## 4. L'espace d'investigation (Dashboard)

- Onglets principaux et sous-onglets : `MAIN_TABS` / `SUB_TABS` (`src/sdk/ui/incident-split.ts:691-707`) ;
  `diagnosis: ['diagnosis', 'hypotheses', 'experiments']`. Les clés de vue `WORKSPACE_TABS`, `VIEW_ROUTES`,
  `STAGE_TABS`, `FULL_WIDTH_VIEWS`, `layoutOf()` sont dans `incident-workspace.ts:144-250` ; libellés dans
  `incident-ux.ts` (`mainTabs` / `subTabs`, 525-540 fr, 837-850 en). Les préférences retiennent le dernier
  sous-onglet par onglet principal (`incident-split.ts:709-777`) : un nouveau sous-onglet est pris en charge sans
  code.
- Composition : `workspacePanes()` (`incident-workspace.ts:1045-1109`) — disposition `document` = panneau
  `content` (`documentBody()`, 846-884) + panneau `details` (caché pour une vue de `FULL_WIDTH_VIEWS` sans
  sélection). `selectionDetail()` (749-783) rend le détail par `SelectionKind` (`incident-links.ts:12-24` :
  `node, edge, request, step, hypothesis, experiment, evidence, event, symbol, file`).
- Diagnostic : `hypothesisCard()` (`incident-diagnosis.ts:1185-1197`) montre statut, couche, confiance, **pas
  d'origine** ; `ruleNote()` (1199-1202) ; `refIndex()` / `refTarget()` (1047-1071) résolvent une référence vers
  requête / preuve / symbole / expérience — une référence inconnue devient du texte (1076). `approvalPanel()`
  (1279-1306) exige `RUN_WRITES`. Les opérations passent par `dxOp()` → `host.op()` (`incident-workspace-controller.ts:957-980`,
  `diagnosisOperation()` 1285-1446) ; une seule opération à la fois (`ui.busy`).
- État : `WorkspaceUi` (`incident-workspace.ts:266-312`, `dx: DiagnosisUi`…), `emptyWorkspaceUi()` (314-336). CSS
  des modules agrégées dans `dashboard-styles.ts:1-10, 1179-1188`. Route : `{ view: 'incident'; …; tab?: IncidentTab }`
  (`dashboard-view.ts:94`), `IncidentTab = WorkspaceTab` (`dashboard-incidents.ts:53`), `incidentView()` (1109-1142).
- Progression : dix étapes `WORKSPACE_STAGES` (`incident-ux.ts:40-51`), textes « n/10 » : **ne pas ajouter d'étape**.
- Démonstration : `demoIncident()` (`incident-demo.ts:4588`), données réelles de la fixture ; une section IA de
  démonstration doit rester statique et étiquetée, ou absente (le rendu doit accepter `investigation.ai` absent).
- Placement recommandé : **sous-onglet `diagnosis › ai` (« Investigation IA »)**, clé de vue `ai`, disposition
  `document`, dans `FULL_WIDTH_VIEWS` ; une sélection (hypothèse, expérience, preuve, symbole) ouvre le panneau des
  détails existant. Six onglets principaux tiennent sur une ligne à 1024 px (`layout-review.md`) ; un septième ou
  une onzième étape romprait cela. Le panneau `details` est réservé à la sélection : pas d'IA permanente dedans.

## 5. Tests existants et ce qu'il manque

- Moteur, en mémoire : `tests/unit/incident-diagnosis.test.ts` (hypothèses, `applyExperiment`, `diagnose` sur des
  symboles et échanges construits à la main, 1-120), `incident-correlator.test.ts`, `incident-evidence.test.ts`.
- Expériences et politique sur dépôts temporaires : `incident-experiments.test.ts:1-60` (`ProcessRunner` simulé,
  rejeu simulé), `incident-policy.test.ts:1-50` (liens symboliques, fichiers sensibles, budgets).
- Stockage : `incident-store.test.ts:1-60` (horloge injectée).
- Serveur + client sans navigateur : `incident-sources.test.ts:1-80` — `startSdkServer({ workspace, language, access:
'named', env: {} })`, `createQaCrawler()`, fixture `tests/fixtures/incident-app` copiée dans un dossier
  temporaire, membre `READER` pour les refus 403.
- Chromium, bout en bout : `tests/integration/incident-reconstruction.test.ts` — `startIncidentSite()`
  (`tests/fixtures/incident-site.ts` : `POST /api/books` → 500 avec `BACKEND_ERROR` `java.lang.NullPointerException`
  sur `CatalogBook.getPublisher()`, 17-24 ; `201` avec éditeur), deux flows YAML écrits dans
  `<workspace>/<projet>/qa-crawler/flows/books/` (88-91), `until()` qui relit l'incident (57-69) ; dépôts
  `frontend/src/books/*`, `bff/src/main/java/org/example/bff/books/*`, `backend/src/main/java/org/example/catalog/books/*`.
- Interface : `sdk-dashboard-incidents.test.ts` (client factice par objets, `IncidentsController`), `incident-ui-*.test.ts`
  (rendu en chaînes), `tests/integration/incident-workspace-review.test.ts` (revue clavier / a11y dans Chromium).
- Projets vitest (`vitest.config.ts`) : `unit` = `tests/unit/**`, 5 s ; `integration` = `tests/integration/**`, 120 s.
- **Faux fournisseur attendu** : `FakeIntelligenceProvider` ne couvre qu'un tour `analyze(request) → raw`. Pour
  l'orchestrateur il faut un fournisseur **scripté multi-tours** : reçoit `{ system, messages, tools }`, rend
  soit des appels d'outils `{ id, name, input }`, soit une réponse finale JSON ; enregistre chaque tour ; sait
  attendre (`delayMs`), échouer, dépasser le délai, répondre hors schéma ou citer une référence inventée ; respecte
  `signal`. Le faux SDK de `ai-anthropic-provider.test.ts:50-80` montre le niveau « shim » ; le faux
  fournisseur se place au niveau du contrat `InvestigationModelClient` (§ 7.2).

## 6. Configuration et secrets : constat

- `ai.enabled` : `false` ; `mode` : `OFF`. Clés : `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` ou `ai.anthropic.apiKeyEnv` ;
  `ai.copilot.tokenEnv` ou compte connecté ; `QA_INTELLIGENCE_ENABLED` (CLI). Jamais écrites, jamais journalisées.
- Redaction : trois couches (`security/redactor.ts`, `persistence/sanitize.ts`, `ai/sanitizer.ts`), à composer en
  une fonction unique pour les paquets de preuves.
- Politique de données : **absente**. Le nettoyage retire des secrets, pas des données d'affaires ; rien ne dit si
  le code source, les corps HTTP, les journaux ou le texte des pages peuvent partir vers un fournisseur externe.
  Le fournisseur `deterministic` et un fournisseur local (`anthropic.baseUrl`) sont les seules voies « sans sortie ».
- Serveur SDK : `ctx.env` passe entier à `IncidentService` ; aucune `AiConfig` n'est disponible côté serveur.

## 7. Réutilisable / à adapter / manquant

| Élément                                                                                                                           | Où                                                        | Verdict                       | Remarque                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Chargement dynamique des SDK (`loadAnthropicSdk`, `loadCopilotSdk`)                                                               | `src/ai/anthropic/sdk.ts:242`, `src/ai/copilot/sdk.ts:95` | **Réutilisable**              | dépendances facultatives, tests par faux SDK                                                             |
| `structuredOutputSchema()`, `extractJson()`                                                                                       | `anthropic-provider.ts:53`, `prompt-builder.ts:207`       | **Réutilisable**              | à exporter d'un module neutre pour les importer depuis `src/incident/ai`                                 |
| `IntelligenceContextSanitizer`, `secretValuesOf()`                                                                                | `sanitizer.ts:299`, `factory.ts:51`                       | **Réutilisable**              | composer avec `redactText` et `maskSource`                                                               |
| `IntelligenceBudgetManager`                                                                                                       | `budget-manager.ts:206`                                   | **À adapter**                 | portées run / action / divergence → run / agent / outil ; ajouter jetons et durée                        |
| `withTimeout()` + boucle de tentatives                                                                                            | `gateway.ts:277-305, 624-638`                             | **À adapter**                 | méthode privée ; extraire une aide `boundedCall()`                                                       |
| `validateEvidence()` (références existantes)                                                                                      | `proposal-validator.ts:30`                                | **À adapter**                 | même principe sur `request.id`, `evidence.id`, `symbol.id`, fichiers de `CodeIndex`                      |
| `AiDecisionRecord` / `IntelligenceAuditTrail`                                                                                     | `audit-trail.ts:59, 215`                                  | **À adapter**                 | forme de l'enregistrement reprise ; stocké dans l'incident, pas en mémoire                               |
| `AI_EVENTS`                                                                                                                       | `gateway.ts:45`                                           | **À adapter**                 | nouveau vocabulaire `AI_INVESTIGATION_*`                                                                 |
| `CopilotToolRegistry` (garde `EXECUTION_VERB`, budget, nettoyage)                                                                 | `copilot/tool-registry.ts:18, 110`                        | **À adapter**                 | lié à `IntelligenceToolContext` ; reprendre la garde et la forme `definitions()`                         |
| `IntelligenceRequest`, `intelligenceProposalSchema`, `IntelligenceGateway.consult()`, `arbitrate()`                               | `model.ts`, `gateway.ts`, `hybrid-arbiter.ts`             | **Non réutilisable tel quel** | domaine du rejeu (actions, SafetyPolicy)                                                                 |
| `ScopePolicy`, `GuardedFiles`, `ExecutionEnvironmentAdapter`                                                                      | `scope-policy.ts`, `guarded-fs.ts`, `environments.ts`     | **Réutilisable**              | la seule porte des outils                                                                                |
| `planExperiment()`, `requestExtension()`                                                                                          | `experiments.ts:57`, `scope.ts:519`                       | **Réutilisable**              | seules « écritures » permises au modèle                                                                  |
| `applyExperiment()`, `meetsConfirmation()`, `diagnose()`                                                                          | `hypotheses.ts`, `root-cause.ts`                          | **Réutilisable, intouchable** | autorité finale                                                                                          |
| Fusion des hypothèses par titre                                                                                                   | `service.ts:576-583`                                      | **À adapter**                 | fusion par `origin` + titre, plafond 0,7                                                                 |
| `track()` / `keep()` / `cancel()` / `settle()`                                                                                    | `service.ts:1090-1141`                                    | **Réutilisable**              | un run IA = un travail suivi                                                                             |
| `LiveProgress` (progression en mémoire)                                                                                           | `live.ts:45`                                              | **À adapter**                 | même motif pour la progression d'un run IA                                                               |
| Appel d'outils multi-tours (fournisseur Anthropic)                                                                                | `anthropic/sdk.ts:198-227`                                | **Manquant**                  | étendre le shim : `tools`, `tool_choice`, blocs `tool_use` / `tool_result`, `stop_reason === 'tool_use'` |
| Recherche textuelle dans le code du périmètre                                                                                     | —                                                         | **Manquant**                  | `search_code` borné (fichiers listés par `GuardedFiles.list`, lecture décomptée, N extraits de K lignes) |
| Budgets par agent, en jetons et en coût                                                                                           | —                                                         | **Manquant**                  | plafonds, compteur d'usage persistant dans le run                                                        |
| Politique de données (ce qui peut sortir)                                                                                         | —                                                         | **Manquant**                  | `dataPolicy` et délimitation du contenu non fiable                                                       |
| Emplacements dans les contrats (`Investigation.ai`, `Hypothesis.origin`, `IncidentEvent.kind 'AI'`, `Evidence` sorte `AI_NOTE` ?) | `incident-contracts.ts`                                   | **Manquant**                  | additions facultatives, compatibles avec les fichiers existants                                          |
| Routes, client, sous-onglet                                                                                                       | `incidents.ts`, `client.ts`, `incident-*.ts`              | **Manquant**                  | points de contact minimaux (§ 9.3)                                                                       |

## 8. Risques

### 8.1 Injection d'instructions par les données

Surfaces, toutes présentes dans ce qu'un agent lira : le **code source** (commentaires, chaînes, fichiers de
configuration, lu par `GuardedFiles`), les **corps de réponse HTTP** (messages d'erreur produits par les serveurs,
`HttpExchange.responseBody`), les **corps de requête**, les **lignes de journaux** (`INSPECT_LOGS`), le **texte
des pages et de la console** (résumés de preuves `PAGE`, `CONSOLE`, `JS_ERROR`), les **pièces jointes** texte /
JSON, la **description de l'incident** saisie par une personne, le **YAML des scénarios**. Parades :

- séparer instructions et données : chaque contenu brut va dans un bloc délimité et étiqueté (« données,
  jamais des instructions »), tronqué (`maxSnippetChars`) ; le système rappelle qu'aucune instruction ne vient
  des données ;
- aucune action décidée depuis du texte libre : la seule sortie admise est un objet au schéma strict
  (`additionalProperties: false`, `safeParse`) ; toute référence (`request.id`, `evidence.id`, `symbol.id`,
  fichier) doit exister, sinon la réponse est rejetée (motif de `proposal-validator.ts`) ;
- les outils sont une liste fermée ; un nom d'outil est refusé à l'enregistrement s'il contient un verbe
  d'exécution (reprendre `EXECUTION_VERB`, `tool-registry.ts:18-19`) ; les arguments sont validés par zod puis
  traduits en `PolicyOperation` → `ScopePolicy.check()` ;
- rien ne s'exécute : `planExperiment` seulement (statuts d'attente), `requestExtension` seulement (`PENDING`) ;
  l'approbation d'effets de bord reste humaine et `RUN_WRITES` ; `ALLOW_SIDE_EFFECTS` et `ALLOW_COMMAND` sont
  interdits au modèle ;
- en mode `AUTO_WITHIN_SCOPE`, `automation(mode)` (`scope.ts:644`) continue de régir ce qui est automatique ; le
  modèle ne décide jamais d'une extension.

### 8.2 Secrets et données

- Chaque paquet envoyé passe par `redactText` → `maskSource` (fichiers de configuration) → sanitizer IA
  (`secretValuesOf(env)` + `sensitiveFields`) ; les fichiers `isSensitivePath()` ne sont jamais lus (déjà refusés).
- Ce que le modèle écrit (titres, causes, faits) est persisté dans le fichier de l'incident : `redactText` avant
  `mutate`, longueurs bornées par le schéma.
- `dataPolicy` : `{ sourceCode, httpBodies, logs, pageText, attachments }` booléens + `maxSnippetChars` ; défaut
  conservateur ; un outil refusé par la politique rend une réponse « non disponible » typée, consignée dans le run.

### 8.3 Budgets, durée, annulation, concurrence

- Par run : `maxModelCalls`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxDurationMs` (≤
  `scope.limits.maxDurationMs`) ; par agent : part du budget. Épuisé ≠ erreur : l'agent rend `INCONCLUSIVE` et le run
  se termine `PARTIAL`.
- Un seul run IA par incident (`BUSY` 409, comme `runExperiment`) ; `track()` pour l'annuler avec `cancel` ;
  signal transmis au fournisseur et à chaque outil.
- Révisions : écrire au début (`RUNNING`) et à la fin ; progression en mémoire (motif `LiveProgress`) servie par
  `incidents.get` ; sinon chaque étape fait échouer les modifications concurrentes (409).
- Taille : trace bornée (nombre d'étapes, caractères par résumé), **jamais les prompts ni les textes bruts**.

### 8.4 Confiance, autorité, non-régression

- Hypothèse IA : `status: 'PROPOSED'`, `confidence ≤ 0,7`, `origin: 'AI'`, `supporting` vérifiés ; dédoublonnée
  contre les hypothèses déterministes par titre normalisé ; le modèle peut **proposer** des `verifications`, pas
  les lancer.
- `diagnose()` inchangé ; le rapport dit, dans `limitations`, qu'une hypothèse d'origine IA n'a pas été éprouvée
  tant qu'aucune expérience ne la soutient (déjà le cas pour toute hypothèse sans expérience).
- `DETERMINISTIC` : aucune ligne du module `src/incident/ai/` exécutée ; les tests existants restent le filet.
- Fournisseur `copilot` : la boucle d'outils est dans son SDK ; le même registre d'outils doit lui être donné
  via `CopilotToolDefinition.handler`, avec la même garde de politique, pour que les deux fournisseurs aient le
  même comportement observable.

## 9. Architecture recommandée

### 9.1 Composants et correspondance

```
Orchestrateur (run borné)                    src/incident/ai/orchestrator.ts
  ├─ Planner                                 src/incident/ai/agents/planner.ts
  ├─ Evidence Analysis                       src/incident/ai/agents/evidence-analysis.ts
  ├─ Frontend / BFF / Backend (parallèle)    src/incident/ai/agents/layer-frontend.ts, layer-bff.ts, layer-backend.ts
  ├─ Cross-Layer                             src/incident/ai/agents/cross-layer.ts
  ├─ Hypothesis                              src/incident/ai/agents/hypothesis.ts
  ├─ Verification Planning                   src/incident/ai/agents/verification-planning.ts
  └─ Synthesis                               src/incident/ai/agents/synthesis.ts
Boucle agentique bornée                      src/incident/ai/loop.ts
Registre d'outils typés → PolicyOperation    src/incident/ai/tools.ts (+ tools/*.ts par famille si volumineux)
Schémas de sortie + validateurs de refs      src/incident/ai/schemas.ts
Paquets de preuves (politique de données)    src/incident/ai/evidence-pack.ts
Budget par run / agent                       src/incident/ai/budget.ts
Fusion vers l'incident (hypothèses, plans)   src/incident/ai/merge.ts
Trace / audit persistés                      src/incident/ai/trace.ts
Contrat de client de modèle + adaptateurs    src/incident/ai/model-client.ts, providers/anthropic.ts, providers/copilot.ts
Configuration                                src/incident/ai/config.ts
Validateur déterministe final                src/incident/root-cause.ts (inchangé) + src/incident/hypotheses.ts (inchangé)
```

- **Orchestrateur** : `runAiInvestigation(context: AiRunContext): Promise<AiInvestigationRun>` où `AiRunContext =
{ incident, mode, policy: ScopePolicy, files: GuardedFiles, adapter, code?, graph?, reproduction?, client:
InvestigationModelClient, budget, dataPolicy, signal, actor, now, onProgress }`. Séquence : Planner (quelles couches,
  quels endpoints, quelles preuves) → Evidence Analysis → agents de couche en parallèle borné (une couche sans
  application dans le périmètre est sautée) → Cross-Layer → Hypothesis → Verification Planning → Synthesis. Chaque
  agent reçoit un paquet de preuves, un sous-ensemble d'outils, un schéma de sortie et une part de budget. Résultat :
  hypothèses candidates, vérifications proposées, demandes d'extension, synthèse textuelle courte, trace.
- **Boucle** (`loop.ts`) : `runAgentLoop({ system, user, tools, schema, maxTurns, maxToolCalls, signal })` : tour du
  modèle → soit `tool_calls` (chacun : zod → `PolicyOperation[]` → `policy.check` → handler → sanitize → borne →
  `tool_result`), soit `final` (→ `schema.safeParse` + validation des références ; une réponse rejetée donne **une**
  reprise avec les raisons, puis `INCONCLUSIVE`). Sortie : `{ output | undefined, turns, toolCalls, usage, reasons }`.
- **Client de modèle** (`model-client.ts`) : `interface InvestigationModelClient { id; model?; isAvailable();
complete(input: { system: string; messages: ModelMessage[]; tools: ToolSpec[]; outputSchema?: Record<string,
unknown>; maxTokens: number }, options: { signal: AbortSignal; timeoutMs: number }): Promise<ModelTurn>; close?() }`,
  `ModelTurn = { kind: 'tool_calls'; calls: { id; name; input: unknown }[]; usage? } | { kind: 'final'; raw: unknown;
usage?; stopReason? }`. Adaptateur Anthropic : messages multi-tours, `tools`, `tool_result`, sortie JSON par
  `output_config.format` au dernier tour (réutilise `loadAnthropicSdk`, `structuredOutputSchema`, `extractJson`) ;
  adaptateur `copilot` : un `createSession` avec `tools` dont les handlers appellent le registre (le SDK boucle),
  `sendAndWait` avec `responseSchema`.
- **Modes** : `DETERMINISTIC` = rien ; `AI_ASSISTED` = un passage, outils de lecture, sorties fusionnées comme
  propositions ; `AI_AGENTIC` = boucle multi-tours avec Planner adaptatif, `maxTurns` plus élevé, et (phase 3,
  derrière une permission de périmètre nouvelle `aiAutoVerify`) lancement automatique des vérifications **sans
  effets de bord** déjà permises, dans `limits.maxExperiments`, via `service.runExperiment` ordinaire.

### 9.2 Nouveaux fichiers (propriétaires disjoints)

| Fichier                                                                                     | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                               | Dépend de                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/sdk/core/incident-ai-contracts.ts`                                                     | `AI_INVESTIGATION_MODES`, `AiInvestigationRun` (`id, mode, status RUNNING\|DONE\|PARTIAL\|FAILED\|CANCELLED, startedAt, finishedAt, provider, model?, budget usage, steps: AiRunStep[], hypotheses: string[] (ids), proposals, extensions, synthesis?, limitations[]`), `AiRunStep` (`agent, status, summary, toolCalls: { name, allowed, rule? }[], usage`), `HypothesisOrigin = 'RULE' \| 'AI'`, `AiInvestigationInput { mode? }`, `AiCapabilities` | rien (types purs)                                                                                  |
| `src/incident/ai/config.ts`                                                                 | schéma zod `incidentAiSchema` : `mode` (défaut `DETERMINISTIC`), `provider` (réutilise `ai.provider`), `budgets { maxModelCalls 24, maxToolCalls 60, maxInputTokens, maxOutputTokens, maxDurationMs 300 000, maxTurnsPerAgent 6 }`, `dataPolicy`, `timeoutMs`, `maxRetries`, `maxSnippetChars 4 000` ; `resolveIncidentAiSettings(ai: AiConfig)`                                                                                                      | `src/config/config.ts` (type)                                                                      |
| `src/incident/ai/model-client.ts`                                                           | contrat `InvestigationModelClient`, `ModelMessage`, `ToolSpec`, `ModelTurn`, erreurs `ModelUnavailableError`, `ModelTimeoutError`                                                                                                                                                                                                                                                                                                                     | —                                                                                                  |
| `src/incident/ai/providers/anthropic.ts` + `anthropic-messages.ts` (shim structurel étendu) | adaptateur Messages multi-tours avec outils                                                                                                                                                                                                                                                                                                                                                                                                           | `src/ai/anthropic/sdk.ts` (`loadAnthropicSdk`), `anthropic-provider.ts` (`structuredOutputSchema`) |
| `src/incident/ai/providers/copilot.ts`                                                      | adaptateur session + outils                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/ai/copilot/*`                                                                                 |
| `src/incident/ai/providers/factory.ts`                                                      | `createInvestigationModelClient(settings, env)` ; `undefined` en `DETERMINISTIC`                                                                                                                                                                                                                                                                                                                                                                      | ci-dessus                                                                                          |
| `src/incident/ai/tools.ts`                                                                  | `InvestigationTool { name, description, input: ZodType, operations(args, ctx): PolicyOperation[], read(args, ctx) }`, `createToolRegistry(ctx, allow: string[])`, garde de verbe, nettoyage, bornes                                                                                                                                                                                                                                                   | `scope-policy.ts`, `guarded-fs.ts`, `service.ts` (`maskSource`)                                    |
| `src/incident/ai/tools/search.ts`                                                           | `searchCode(files, apps, query, { maxHits, context })` borné (nouveau)                                                                                                                                                                                                                                                                                                                                                                                | `guarded-fs.ts`                                                                                    |
| `src/incident/ai/evidence-pack.ts`                                                          | paquets par agent (reproduction, requêtes en erreur, graphe voisin, symboles ciblés), délimitation « données », troncature, `dataPolicy`, `redact()` composé                                                                                                                                                                                                                                                                                          | `src/ai/sanitizer.ts`, `src/security/redactor.ts`                                                  |
| `src/incident/ai/schemas.ts`                                                                | zod + JSON Schema de chaque sortie d'agent (`PlannerOutput`, `LayerFindings`, `CrossLayerFindings`, `HypothesisProposals`, `VerificationPlan`, `Synthesis`), `validateRefs(output, index)`                                                                                                                                                                                                                                                            | `model.ts`                                                                                         |
| `src/incident/ai/prompts.ts`                                                                | instructions système par agent (anglais, courtes, règles « jamais agir », « cite only provided ids »)                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                  |
| `src/incident/ai/budget.ts`                                                                 | `InvestigationBudget` (run / agent / jetons / durée), `usage()`                                                                                                                                                                                                                                                                                                                                                                                       | `src/ai/budget-manager.ts` (motif)                                                                 |
| `src/incident/ai/loop.ts`                                                                   | `runAgentLoop()`                                                                                                                                                                                                                                                                                                                                                                                                                                      | `model-client.ts`, `tools.ts`, `budget.ts`                                                         |
| `src/incident/ai/agents/*.ts`                                                               | un agent = `{ name, allowedTools, schema, prompt, pack(ctx), run(ctx) }`                                                                                                                                                                                                                                                                                                                                                                              | `loop.ts`, `schemas.ts`, `evidence-pack.ts`                                                        |
| `src/incident/ai/merge.ts`                                                                  | `toHypotheses(proposals, index, now)` → `Hypothesis[]` (`id: hyp-ai-<n>`, `origin: 'AI'`, `status: 'PROPOSED'`, `confidence ≤ 0.7`, refs validées), `toProposedVerifications()`, `toExtensionRequests()`, `mergeHypotheses(existing, incoming)`                                                                                                                                                                                                       | `hypotheses.ts` (`MAX_CONFIDENCE_WITHOUT_EXPERIMENT`)                                              |
| `src/incident/ai/trace.ts`                                                                  | `AiRunTrace` borné, `toRun()`, `AI_INVESTIGATION_EVENTS`                                                                                                                                                                                                                                                                                                                                                                                              | contrats                                                                                           |
| `src/incident/ai/orchestrator.ts`                                                           | `runAiInvestigation(context)`                                                                                                                                                                                                                                                                                                                                                                                                                         | tout ce qui précède                                                                                |
| `src/incident/ai/index.ts`                                                                  | exports publics                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                  |
| `src/sdk/server/incident-ai.ts`                                                             | `handleIncidentAiRoutes(ctx, id, part)` : `POST …/ai/investigate` (202, corps `{ mode? }`), `POST …/ai/cancel`, `GET …/ai/capabilities`, `GET …/ai/runs/:run`                                                                                                                                                                                                                                                                                         | `incidents.ts` (type `IncidentRouteContext`)                                                       |
| `src/sdk/ui/incident-ai.ts`                                                                 | `AiUi`, `emptyAiUi()`, `reduceAi()`, `renderAiInvestigation(ctx, ui)`, `renderAiRunDetail()`, `INCIDENT_AI_CSS`, `TEXT` fr/en                                                                                                                                                                                                                                                                                                                         | `incident-parts.ts`, `incident-diagnosis.ts` (puces)                                               |
| `src/sdk/ui/incident-ai-controller.ts`                                                      | `aiOperation(action, target, host)` branché sur `dxOp` / `host.op`                                                                                                                                                                                                                                                                                                                                                                                    | `incident-workspace-controller.ts`                                                                 |
| `tests/fixtures/scripted-model-client.ts`                                                   | faux client multi-tours scripté                                                                                                                                                                                                                                                                                                                                                                                                                       | `model-client.ts`                                                                                  |
| `docs/incident-reconstruction/ai-investigation.md`                                          | guide : modes, politique, budgets, limites                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                  |

### 9.3 Points de contact minimaux dans l'existant

| Fichier                                           | Changement                                                                                                                                                                                                                                                                                                                              | Ampleur              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `src/sdk/core/incident-contracts.ts`              | `export * from './incident-ai-contracts.js'` ; `Investigation.ai?: { runs: AiInvestigationRun[] }` (736 ↓) ; `Hypothesis.origin?: HypothesisOrigin` (630-644) ; `IncidentEvent.kind` + `'AI'` (705-722) ; `REPORT_SECTIONS` + `'ai'` facultatif                                                                                         | ≈ 8 lignes           |
| `src/config/config.ts`                            | dans `aiSchema` : `incidents: incidentAiSchema.prefault({})` (importé de `src/incident/ai/config.ts`, ou défini en place si la dépendance inverse gêne)                                                                                                                                                                                 | ≈ 3 lignes           |
| `src/incident/service.ts`                         | `deps.ai?: IncidentAiRuntime` (184-196) ; `investigate(id, actor, { mode? })` (202 : `mutate` run `RUNNING`, `track`, `keep`, progression en mémoire, fusion finale par `merge.ts`, événement `AI`) ; `cancelInvestigation(id, actor)` ; `aiCapabilities(id)` ; `incident()` sert la progression en mémoire comme pour `live` (218-233) | ≈ 70 lignes, un bloc |
| `src/incident/hypotheses.ts`                      | rien (si `recommendationsFor` doit parler des hypothèses IA : une branche `default` qui reprend `hypothesis.verifications`)                                                                                                                                                                                                             | 0-5 lignes           |
| `src/incident/report.ts`                          | section `ai` facultative (résumé du dernier run, limites) ; `limitationsOf` : « n hypothèse(s) d'origine IA non éprouvée(s) »                                                                                                                                                                                                           | ≈ 15 lignes          |
| `src/sdk/server/incidents.ts`                     | `if (id !== undefined && action === 'ai') return handleIncidentAiRoutes(ctx, id, part, item)` (58 ↓) ; traduction d'une erreur `AI_UNAVAILABLE` → 503                                                                                                                                                                                   | ≈ 4 lignes           |
| `src/sdk/server/access.ts`                        | rien : `incidentRight()` rend `RUN` pour `ai/*` ; si l'on veut réserver `AI_AGENTIC` à `DECIDE`, une ligne (310-316)                                                                                                                                                                                                                    | 0-1 ligne            |
| `src/sdk/server/server.ts`                        | `SdkServerOptions.ai?: AiConfig` (238) ; `incidentService()` : `new IncidentService(host, { env: ctx.env, ai: createIncidentAiRuntime(ctx.ai, ctx.env) })` (3520)                                                                                                                                                                       | ≈ 6 lignes           |
| `src/sdk/core/client.ts`                          | `incidents.investigate`, `incidents.cancelInvestigation`, `incidents.aiCapabilities` (interface 559-680, impl. 1175-1255)                                                                                                                                                                                                               | ≈ 15 lignes          |
| `src/sdk/ui/incident-split.ts`                    | `SUB_TABS.diagnosis: ['diagnosis', 'hypotheses', 'experiments', 'ai']` (699)                                                                                                                                                                                                                                                            | 1 ligne              |
| `src/sdk/ui/incident-workspace.ts`                | `WORKSPACE_TABS` + `'ai'` ; `VIEW_ROUTES.ai = { tab: 'diagnosis', sub: 'ai' }` ; `FULL_WIDTH_VIEWS` + `'ai'` ; `WorkspaceUi.ai: AiUi` + `emptyWorkspaceUi` ; `documentBody` : `case 'ai'` ; `selectionDetail` : rien si l'on sélectionne des objets existants                                                                           | ≈ 10 lignes          |
| `src/sdk/ui/incident-ux.ts`                       | `subTabs.ai` fr/en                                                                                                                                                                                                                                                                                                                      | 2 lignes             |
| `src/sdk/ui/incident-diagnosis.ts`                | puce d'origine dans `hypothesisCard()` (1185-1197) et dans `renderHypothesisDetail()` ; texte `hyp.originAi`                                                                                                                                                                                                                            | ≈ 6 lignes           |
| `src/sdk/ui/incident-workspace-controller.ts`     | dans `click()` : `if (action.startsWith('ws-ai-')) return aiOperation(...)` ; sondage : rien (révision + progression en mémoire)                                                                                                                                                                                                        | ≈ 3 lignes           |
| `src/sdk/ui/dashboard-styles.ts`                  | import + `${INCIDENT_AI_CSS}`                                                                                                                                                                                                                                                                                                           | 2 lignes             |
| `src/sdk/ui/incident-demo.ts`                     | rien en phase 1 (`ai` absent) ; phase 2 : un run statique étiqueté                                                                                                                                                                                                                                                                      | 0 puis ≈ 40 lignes   |
| `docs/INCIDENT_RECONSTRUCTION.md`, `CHANGELOG.md` | arborescence § 2, API § 6, limites § 8                                                                                                                                                                                                                                                                                                  | documentation        |

Règle d'or pour les ingénieurs en parallèle : chacun possède ses fichiers neufs ; les points de contact
ci-dessus sont tenus par **une** personne (intégration), et les signatures des contrats (`incident-ai-contracts.ts`,
`model-client.ts`, `tools.ts`) sont figées en phase 0.

## 10. Plan par phases

| Phase                                 | Livrables                                                                                                                                                                                                                                                                                                                                         | Sortie vérifiable                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Socle** (1 personne, bloquante) | `incident-ai-contracts.ts`, `config.ts` (`ai.incidents`, défaut `DETERMINISTIC`), `model-client.ts`, `tools.ts` (contrat + garde + 4 outils de lecture : `get_incident_summary`, `get_request`, `get_evidence`, `read_source`), `budget.ts`, `evidence-pack.ts`, `schemas.ts` (Hypothesis + Synthesis), `tests/fixtures/scripted-model-client.ts` | `npm run typecheck`, tous les tests existants inchangés ; en `DETERMINISTIC` aucun module `src/incident/ai/` importé par le serveur à l'exécution                          |
| **1 — AI_ASSISTED, un passage**       | `loop.ts` (un tour d'outils au plus), agents `evidence-analysis`, `hypothesis`, `synthesis`, `merge.ts`, `trace.ts`, `orchestrator.ts`, `service.investigate`, route + client, sous-onglet « Investigation IA » minimal (lancer, progression, résultat, limites), puce d'origine                                                                  | tests unitaires avec le client scripté ; test serveur + client ; test UI en chaînes                                                                                        |
| **2 — Agents de couche**              | `planner`, `layer-*`, `cross-layer`, `verification-planning`, outil `search_code`, `get_graph_neighbours`, `get_symbol`, `propose_experiment`, `request_scope_extension` ; budgets par agent ; section `ai` du rapport ; démonstration statique                                                                                                   | test d'intégration Chromium sur la fixture avec client scripté (le run propose `hyp-ai-1` « publisherId absent », plan `COMPARE_WITH_PASSING`) ; revue a11y du sous-onglet |
| **3 — AI_AGENTIC**                    | boucle multi-tours (`maxTurnsPerAgent`), Planner adaptatif, annulation en cours de run, `aiAutoVerify` (vérifications sans effets de bord, dans `maxExperiments`), progression en mémoire servie par `get`                                                                                                                                        | tests d'annulation, d'épuisement de budget, de refus de politique en cours de boucle, de réponse hors schéma puis reprise                                                  |
| **4 — Fournisseurs réels**            | `providers/anthropic.ts` (shim étendu), `providers/copilot.ts`, usage et modèle dans la trace, documentation, CHANGELOG                                                                                                                                                                                                                           | tests par faux SDK (motif `ai-anthropic-provider.test.ts`), aucun appel réseau dans la CI                                                                                  |

## 11. Tests à écrire

Unitaires (`tests/unit/`) :

- `incident-ai-config.test.ts` : défauts (`DETERMINISTIC`, budgets), `resolveIncidentAiSettings`, refus de valeurs hors bornes.
- `incident-ai-tools.test.ts` : chaque outil → opérations déclarées → `ScopePolicy.check` (refus `path.traversal`, `path.sensitive`, hors `include`) ; nom à verbe d'exécution refusé ; résultat nettoyé (secret dans `application.yml`) et borné ; `search_code` décompte `limits.maxFiles`.
- `incident-ai-evidence-pack.test.ts` : `dataPolicy` (code refusé → paquet sans extrait, limite signalée), délimitation, troncature, masquage composé.
- `incident-ai-schemas.test.ts` : sortie valide ; référence inventée → rejet ; `confidence` hors [0,1] → rejet ; longueurs.
- `incident-ai-loop.test.ts` : un tour, N tours, `maxToolCalls`, délai, `signal` → `CANCELLED`, réponse hors schéma → une reprise puis `INCONCLUSIVE`, outil refusé par la politique renvoyé au modèle comme `tool_result` typé.
- `incident-ai-merge.test.ts` : `hyp-ai-<n>`, `origin: 'AI'`, `PROPOSED`, plafond 0,7, dédoublonnage par titre, `applyExperiment` monte une hypothèse IA exactement comme une hypothèse de règle, `diagnose` ne la confirme jamais sans deux expériences.
- `incident-ai-orchestrator.test.ts` : avec le client scripté sur les données de `incident-diagnosis.test.ts` : séquence des agents, budgets par agent, run `PARTIAL` sur épuisement, événements et trace bornés, aucun appel en `DETERMINISTIC`.
- `incident-ai-service.test.ts` : `investigate` → `BUSY` si déjà en cours, `track` / `cancel`, événement `AI`, révision écrite deux fois, progression en mémoire via `incident()`, `settle()`.
- `incident-ai-routes.test.ts` : `startSdkServer({ …, ai })` + `createQaCrawler` : 202, 409, 403 pour `READER`, 503 `AI_UNAVAILABLE` sans fournisseur, `capabilities`.
- `incident-ai-providers.test.ts` : faux SDK Anthropic multi-tours (`tool_use` → `tool_result` → `final`), refus, `max_tokens`, usage ; faux SDK `copilot` (handlers appelés, `responseSchema`).
- `incident-ui-ai.test.ts` : rendu du sous-onglet (vide, en cours, `PARTIAL`, `FAILED`, démonstration), puce d'origine, boutons selon droits (`RUN`), actions désactivées en démonstration, `tabsOf` / `viewOf('diagnosis','ai')`.
- Mise à jour : `incident-ui-workspace.test.ts` (nouvelle clé de vue), `sdk-dashboard-incidents.test.ts` (routes client), `incident-report.test.ts` (section `ai`, limitation).

Intégration (`tests/integration/`) :

- `incident-ai-investigation.test.ts` : l'incident connu (`startIncidentSite`, `incident-app`), reproduction réelle,
  `analyze`, puis `investigate` en `AI_ASSISTED` avec le client scripté branché par `startSdkServer({ ai, … })` :
  les hypothèses IA apparaissent `PROPOSED` avec origine, la vérification `COMPARE_WITH_PASSING` proposée s'exécute
  par le chemin ordinaire et fait monter l'hypothèse ; `diagnose` reste `PROBABLE` tant qu'une seconde sorte
  d'expérience manque ; en `DETERMINISTIC` le fichier d'incident est identique à celui d'aujourd'hui.
- `incident-workspace-review.test.ts` : ajouter le sous-onglet à `VIEWS`, aucun défilement horizontal, ids uniques,
  noms accessibles, lecteur sans bouton.

# AI Reasoning Advisor (GitHub Copilot SDK)

> **COPILOT CAN THINK. QA-CRAWLER DECIDES WHAT IS VALID. THE SAFETY POLICY DECIDES WHAT IS
> ALLOWED. PLAYWRIGHT EXECUTES. THE RUNTIME DECIDES WHAT IS TRUE.**

QA-Crawler peut consulter **GitHub Copilot** (par le SDK officiel `@github/copilot-sdk`) comme
**conseiller de raisonnement**, quand une situation est réellement difficile : cible ambiguë,
écran inconnu, divergence du parcours enregistré, récupération déterministe épuisée, erreur
métier inconnue, hypothèse non résolue, contradiction entre sources.

Copilot **comprend, analyse, propose, explique**. QA-Crawler **valide, vérifie la sécurité,
exécute, observe, vérifie et apprend**. Copilot ne clique jamais, ne saisit jamais, ne navigue
jamais, n'exécute jamais de JavaScript : il ne dispose d'aucun outil d'exécution.

La fonctionnalité est **désactivée par défaut** (`ai.mode: OFF`) : aucun client créé, aucune
session, aucun appel réseau, aucun changement de décision.

## Sommaire

1. [Audit de l'existant et points d'insertion](#1-audit-de-lexistant-et-points-dinsertion)
2. [Architecture](#2-architecture)
3. [Modes : OFF, ASSIST, HYBRID](#3-modes--off-assist-hybrid)
4. [Configuration, CLI, environnement](#4-configuration-cli-environnement)
5. [Authentification](#5-authentification)
6. [Quand Copilot est-il consulté ? (trigger policy)](#6-quand-copilot-est-il-consulté--trigger-policy)
7. [La requête : contexte sémantique, minimal, nettoyé](#7-la-requête--contexte-sémantique-minimal-nettoyé)
8. [La proposition : structurée, validée](#8-la-proposition--structurée-validée)
9. [Arbitrage hybride et SafetyPolicy](#9-arbitrage-hybride-et-safetypolicy)
10. [Vérité du runtime et apprentissage](#10-vérité-du-runtime-et-apprentissage)
11. [Outils de lecture et défense en profondeur](#11-outils-de-lecture-et-défense-en-profondeur)
12. [Budgets, pannes, délais](#12-budgets-pannes-délais)
13. [Audit, événements, rapport, mesures](#13-audit-événements-rapport-mesures)
14. [Tests](#14-tests)
15. [Docker et dépendance optionnelle](#15-docker-et-dépendance-optionnelle)
16. [Limites et évolutions](#16-limites-et-évolutions)

## 1. Audit de l'existant et points d'insertion

Rien n'est réimplémenté : la couche d'intelligence s'insère dans les composants existants.

| Composant existant                                                                         | Rôle dans l'intégration                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `QAReasoningEngine` (`src/cognitive/reasoning-engine.ts`)                                  | Décision **déterministe** (FAST / DEEP), sa confiance et ses alternatives : c'est ce que l'arbitre compare.   |
| Moteur de décision + `AdvancedActionScorer`                                                | Choisit toujours l'action en exploration. Une proposition retenue n'est qu'un **signal** (`cognitive`).       |
| `SafetyPolicy` (`safety.evaluate`, `judgeRecovery`)                                        | Juge **chaque** action proposée. Seul SAFE passe ; inchangée, jamais contournée.                              |
| `healWorkflow` + `GoalBasedRecoveryEngine`                                                 | Récupération déterministe d'abord. Le conseiller n'est consulté qu'**après** son échec, via un port `advise`. |
| `RecoveryDriver` (exécuteur Playwright existant)                                           | Exécute l'action retenue, la **rejuge** au moment d'exécuter, vérifie l'objectif.                             |
| `EvidenceStore` / `HypothesisEngine` / `ContradictionDetector` / `FunctionalCoverageGraph` | Sources du contexte ; une preuve citée doit exister dans l'`EvidenceStore`.                                   |
| `BusinessStateEngine`, `GoalGraph`, `WorkflowActionContext`                                | But, état métier, étapes précédentes/suivantes, champs attendus.                                              |
| `FailureUnderstanding`                                                                     | Une erreur `UNKNOWN_FAILURE` peut être analysée (avis consigné, jamais décisionnaire).                        |
| Redactor (`security/redactor`, `persistence/sanitize`)                                     | Base du nettoyage de chaque requête.                                                                          |
| `EngineEventLog`, rapport HTML, CLI, `ExplorationResult`                                   | Événements `AI_*`, section « AI Intelligence », résumé.                                                       |

`intelligence:` (YAML) reste l'intelligence **historique déterministe** (confiance, vieillissement,
nouveauté, stabilité) ; le conseiller vit sous la clé `ai:` et dans `src/ai/`.

Points d'insertion (et seulement ceux-là) :

- **Exploration** : `FlowExplorer.reasonAboutState` → `adviseExploration` (après la décision raisonnée).
- **Récupération** : `healWorkflow` → port `advise` / `adviceOutcome` (après l'échec déterministe).
- **Erreur inconnue** : après `understandStep` → `adviseFailure` (avis seulement).

Aucun appel depuis l'exécuteur Playwright, le RecoveryEngine, le SemanticResolver, le GoalPlanner
ou l'ActionDiscovery : **l'`IntelligenceGateway` est l'unique point d'entrée**.

## 2. Architecture

```
                    QA-CRAWLER
                         │
                 QAReasoningEngine / healWorkflow (déterministe d'abord)
                         │
              IntelligenceTriggerPolicy  ── FAST PATH : aucun appel
                         │ (situation difficile)
                IntelligenceGateway  (budget, paresse, isolation des pannes)
                         │
      IntelligenceContextBuilder → IntelligenceContextSanitizer
                         │
        IntelligenceProvider  (copilot | deterministic | injecté)
                         │
                  AI Proposal (JSON structuré)
                         │
          ProposalValidator (schéma, actions, cohérence)
                         │
           EvidenceValidator (preuves existantes)
                         │
             HybridDecisionArbiter (mode, confiance)
                         │
                   SafetyPolicy (existante)
                         │
               Exécuteur existant (Playwright)
                         │
          Vérification de l'effet / de l'objectif
                         │
                   Runtime truth → audit, hypothèses
```

```
src/ai/
  model.ts                 modes, déclencheurs, IntelligenceRequest, IntelligenceProposal (zod + JSON Schema)
  provider.ts              IntelligenceProvider
  gateway.ts               IntelligenceGateway, événements AI_*
  trigger-policy.ts        IntelligenceTriggerPolicy (FAST / DEEP)
  context-builder.ts       IntelligenceContextBuilder, outils de lecture (toolContextOf)
  sanitizer.ts             IntelligenceContextSanitizer
  proposal-validator.ts    IntelligenceProposalValidator + EvidenceValidator
  hybrid-arbiter.ts        HybridDecisionArbiter
  budget-manager.ts        IntelligenceBudgetManager
  audit-trail.ts           IntelligenceAuditTrail, mesures
  factory.ts               passerelle depuis la configuration (rien en OFF)
  providers/
    deterministic-provider.ts   sans réseau (exerce toute la chaîne)
    copilot-provider.ts         CopilotIntelligenceProvider
  copilot/
    sdk.ts                 types structurels + chargement dynamique du SDK
    client-manager.ts      CopilotClientManager (cycle de vie, paresse, auth, arrêt)
    session-factory.ts     session spécialisée, défense en profondeur
    prompt-builder.ts      instructions système, message, extraction JSON
    tool-registry.ts       outils en LECTURE SEULE
```

Le SDK n'est importé **que** dans `src/ai/copilot/sdk.ts`, par import dynamique : le cœur ne
dépend pas de Copilot, et un fournisseur futur (`UIUnderstandingAdvisor`, `RecoveryAdvisor`…)
s'ajoute en implémentant `IntelligenceProvider`, sans toucher au cœur.

## 3. Modes : OFF, ASSIST, HYBRID

| Mode           | Copilot est-il appelé ?                               | Influence sur l'exécution                                                                                                                                        |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OFF` (défaut) | Jamais : aucun client, aucune session, SDK non chargé | Aucune — comportement d'avant, exactement                                                                                                                        |
| `ASSIST`       | Dans les situations difficiles (trigger policy)       | **Aucune** : la décision déterministe est exécutée ; la proposition est seulement auditée (shadow, `AI_SHADOW_DISAGREEMENT`)                                     |
| `HYBRID`       | Dans les situations difficiles                        | Une proposition **validée**, **autorisée** et **plus sûre** que le déterministe peut être retenue, puis exécutée par l'exécuteur existant et vérifiée au runtime |

`ai.enabled: false` vaut OFF quel que soit `ai.mode`. Il n'existe pas de mode « full AI ».

## 4. Configuration, CLI, environnement

```yaml
ai:
  enabled: true
  mode: HYBRID # OFF | ASSIST | HYBRID
  provider: copilot # copilot | deterministic (même chaîne, sans réseau)
  failOnUnavailable: false # true : un fournisseur indisponible arrête le run
  copilot:
    model: auto # ou un identifiant, validé avec listModels() du SDK
    reasoningEffort: auto # auto | low | medium | high | xhigh (si le modèle le déclare)
    adaptiveReasoning: true # auto : plus d'effort pour une divergence, une récupération épuisée…
    timeoutMs: 30000
    maxRetries: 1
    sessionReuse: true
    tools: true # outils de LECTURE exposés au modèle
    baseDirectory: .qa-crawler/copilot # données du runtime Copilot, hors du dépôt
    # tokenEnv: QA_COPILOT_TOKEN          # NOM d'une variable d'environnement (jamais la valeur)
  triggers:
    ambiguousTarget: true
    unknownScreen: true
    flowDivergence: true
    recoveryFailed: true
    multiplePlans: true
    unresolvedHypothesis: true
    unknownBusinessError: true
    lowConfidence: true
    knowledgeContradiction: true
  thresholds:
    deterministicConfidence: 0.85 # au-dessus : FAST PATH, aucun appel
    minProposalConfidence: 0.6
    overrideMargin: 0.15 # écart exigé pour préférer la proposition au déterministe
  budgets:
    maxCallsPerRun: 10
    maxCallsPerAction: 1
    maxCallsPerDivergence: 1
    maxToolCallsPerRequest: 6
    maxReasoningDurationMs: 60000
  context:
    maxActions: 25
    maxEvidence: 15
    maxHypotheses: 8
    sensitiveFields: [] # libellés dont aucune valeur ne doit partir
  audit:
    enabled: true # reports/ai/intelligence.json
```

Priorité : CLI, puis environnement, puis YAML.

| CLI                                    | Environnement                 | Effet                                    |
| -------------------------------------- | ----------------------------- | ---------------------------------------- |
| `--intelligence off\|assist\|hybrid`   | `QA_INTELLIGENCE_MODE`        | Mode (assist / hybrid active, off coupe) |
| —                                      | `QA_INTELLIGENCE_ENABLED`     | `ai.enabled`                             |
| `--ai-provider copilot\|deterministic` | `QA_INTELLIGENCE_PROVIDER`    | Fournisseur                              |
| `--ai-model <id>`                      | `QA_COPILOT_MODEL`            | Modèle Copilot                           |
| —                                      | `QA_COPILOT_REASONING_EFFORT` | Effort de raisonnement                   |

```bash
npm run qa -- scenarios/mission.yaml --intelligence assist        # mesurer, sans influencer
npm run qa -- scenarios/mission.yaml --intelligence hybrid        # aide validée
QA_INTELLIGENCE_MODE=hybrid npm run qa -- scenarios/mission.yaml
```

## 5. Authentification

Uniquement par les mécanismes officiels du SDK :

- **en local** : l'utilisateur GitHub déjà connecté à Copilot (`useLoggedInUser`, par défaut) ;
- **en automatisation / CI** : un jeton fourni par l'environnement, dont la configuration ne
  contient que le **nom** de la variable (`ai.copilot.tokenEnv: QA_COPILOT_TOKEN`).

Le jeton n'est **jamais** écrit dans un flow, la configuration, un rapport, `engine-log.jsonl`,
la console, une raison d'indisponibilité ni un prompt (vérifié par les tests). Le client
démarre en mode `empty` du SDK, avec son propre dossier de données (`ai.copilot.baseDirectory`).

## 6. Quand Copilot est-il consulté ? (trigger policy)

Le but n'est **pas** « action → Copilot → action → Copilot ». Le chemin par défaut est le
**FAST PATH** déterministe : état connu, but connu, confiance ≥ `deterministicConfidence` →
aucun appel.

Déclencheurs (dans l'ordre de gravité) :

| Déclencheur                                                            | Situation                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `RECOVERY_EXHAUSTED`                                                   | La récupération déterministe a échoué (aucun chemin sûr, budget, ambiguïté) |
| `UNKNOWN_BUSINESS_ERROR`                                               | Un échec que le FailureUnderstanding classe `UNKNOWN_FAILURE`               |
| `FLOW_DIVERGENCE`                                                      | Le parcours diverge de l'enregistrement                                     |
| `KNOWLEDGE_CONTRADICTION`                                              | Des sources se contredisent et la décision reste sans conclusion            |
| `AMBIGUOUS_TARGET`                                                     | Deux candidats aussi plausibles                                             |
| `MULTIPLE_PLAUSIBLE_PLANS`, `UNKNOWN_SCREEN`, `UNKNOWN_WORKFLOW_STATE` | Plans concurrents, écran ou état inconnus                                   |
| `UNRESOLVED_BUSINESS_INTENT`, `UNRESOLVED_HYPOTHESIS`                  | Intention ou hypothèse non résolues                                         |
| `LOW_DECISION_CONFIDENCE`                                              | Confiance déterministe sous le seuil                                        |

Chaque déclencheur se désactive dans `ai.triggers`.

## 7. La requête : contexte sémantique, minimal, nettoyé

`IntelligenceRequest` : `requestId`, `trigger`, mission, but et conditions, état métier (phase,
faits, conditions manquantes, envoi), état fonctionnel, contexte du parcours (étapes
précédentes, suivantes, champs attendus, intention), plan, décision déterministe (pour
comparer), **actions disponibles**, preuves pertinentes, hypothèses, contradictions, trous de
couverture, symptôme d'échec, contraintes.

- **Jamais le DOM** : les actions déjà découvertes, avec un identifiant stable (`A1`, `A2`…),
  leur type (`TAB`, `LINK`, `BUTTON`…), leur nom, leur sûreté (SAFE / MUTATION / DANGEROUS)
  jugée par la SafetyPolicy.
- **Pertinent seulement** : preuves et hypothèses qui partagent des mots avec le but, la suite du
  parcours ou les actions (bornées par `ai.context`).
- **Nettoyé** (`IntelligenceContextSanitizer`) : redactor du crawler (Bearer, JWT,
  Authorization/Cookie, `password=`, cartes, IBAN), puis adresses → `<EMAIL_TEST_DATA>`, jetons
  GitHub et clés → `<AUTH_TOKEN_REDACTED>`, valeurs secrètes de l'environnement et des TestData
  → `<PASSWORD_SECRET>`, champs sensibles configurés → `<SENSITIVE_VALUE_REDACTED>`. Le nombre
  de valeurs masquées est journalisé (`AI_REQUEST_SANITIZED`), jamais les valeurs.

Les instructions système (`QA_ADVISOR_SYSTEM_PROMPT`) remplacent celles d'un agent de code : ne
rien exécuter, distinguer faits et hypothèses, ne citer que les identifiants fournis, ne jamais
inventer d'élément ni de sélecteur, ne jamais discuter une classification de sûreté, le runtime
prime sur l'historique, le code statique soutient sans prouver, chaque requête se suffit à
elle-même.

## 8. La proposition : structurée, validée

```ts
interface IntelligenceProposal {
  status: 'PROPOSAL' | 'INCONCLUSIVE' | 'NEED_MORE_EVIDENCE';
  intent?: string;
  selectedActionId?: string; // un identifiant de la requête, jamais un locator
  proposedGoal?: { id: string; description?: string };
  hypothesis?: { statement: string; evidenceIds: string[] };
  plan?: { steps: string[]; rationale?: string };
  expectedEffects?: {
    kind: 'VISIBLE_CONTROL' | 'VISIBLE_FIELD' | 'ROUTE' | 'GOAL_REACHED' | 'TEXT';
    value: string;
  }[];
  failureCategory?: string;
  nextInvestigation?: string;
  supportingEvidenceIds: string[];
  uncertainties: string[];
  confidence: number; // 0..1
  summary?: string; // court ; jamais de « chaîne de pensée »
}
```

Copilot reçoit le contrat en **sortie structurée** (JSON Schema). QA-Crawler revalide toujours la
réponse avec zod, en mode strict :

| Rejet                             | Cause                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AI_PROPOSAL_INVALID_SCHEMA`      | Champ inconnu, type ou borne invalide, JSON illisible                                            |
| `AI_PROPOSAL_UNKNOWN_ACTION`      | Une action (ou étape de plan) qui n'existe pas à l'écran (ex. `A999`)                            |
| `AI_PROPOSAL_INCOMPATIBLE`        | Hors des identifiants permis, plan trop long                                                     |
| `AI_PROPOSAL_CONTRADICTS_RUNTIME` | La cible est désactivée au runtime                                                               |
| `AI_PROPOSAL_INVALID_EVIDENCE`    | Une preuve citée n'existe pas (ex. `E999`) : la proposition est **rejetée**, jamais « nettoyée » |
| `AI_PROPOSAL_EMPTY`               | `PROPOSAL` sans contenu                                                                          |

## 9. Arbitrage hybride et SafetyPolicy

```
Proposition → ProposalValidator → EvidenceValidator → résolution de l'action → SafetyPolicy → exécuteur
```

| Cas                                                                                     | Résultat                                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Déterministe fort (A17 = 0,96), Copilot A19 = 0,62                                      | A17 est gardée                                                                      |
| Déterministe faible (A17 = 0,42, A19 = 0,40), Copilot A19 = 0,89, preuves valides, SAFE | A19 peut devenir l'action choisie                                                   |
| Copilot A17, mais A17 est désactivée au runtime                                         | Rejet (`AI_PROPOSAL_CONTRADICTS_RUNTIME`)                                           |
| Copilot INCONCLUSIVE                                                                    | Aucune décision forcée : récupération existante, exploration bornée ou INCONCLUSIVE |
| Copilot propose une MUTATION ou une action DANGEROUS                                    | SafetyPolicy : refus, rien n'est exécuté                                            |

Copilot ne peut **ni** reclasser une action, **ni** contourner la politique de mutation, **ni**
forcer une action, **ni** désactiver la SafetyPolicy.

En **exploration**, une proposition retenue reçoit le signal `cognitive` du moteur de décision
(qui choisit toujours, après la SafetyPolicy). En **récupération**, l'action retenue est
exécutée par le `RecoveryDriver` existant, qui la rejuge au moment d'exécuter.

## 10. Vérité du runtime et apprentissage

- Récupération : après l'action, l'objectif fonctionnel est vérifié (`driver.progress`). Atteint
  → `AI_RUNTIME_CONFIRMED`, l'étape est `GOAL_RECOVERED` avec `pathSource: AI_PROPOSAL`, et le
  parcours continue. Pas atteint → `AI_RUNTIME_CONTRADICTED`, l'étape échoue normalement : jamais
  un PASS, jamais appris.
- Exploration : les effets attendus (contrôles, champs, route) sont comparés à ce qui est apparu.
  Une proposition retenue que le moteur n'a finalement pas exécutée est notée `NOT_EXECUTED`.
- Une proposition n'entre **jamais** directement dans la KnowledgeBase. Une hypothèse proposée
  devient au plus une **AI_PROPOSED_HYPOTHESIS** (preuve `LLM_PROPOSAL`, plafonnée, origine
  `AI_PROPOSAL`). Une proposition confirmée au runtime devient un **candidat de connaissance**
  (`knowledgeCandidate: { origin: AI_PROPOSAL, runtimeConfirmed: true }`). Ce candidat est
  ensuite soumis aux règles habituelles : observations runtime distinctes, source indépendante.
- La mémoire de session de Copilot n'est jamais une vérité : l'état vient toujours de la requête
  courante (ou des outils), et une action d'un ancien écran est rejetée par la validation.

## 11. Outils de lecture et défense en profondeur

Outils exposés (lecture seule, résultats nettoyés, bornés par `maxToolCallsPerRequest`) :

| Outil                     | Ce qu'il renvoie                                           |
| ------------------------- | ---------------------------------------------------------- |
| `get_current_goal`        | Le but courant                                             |
| `get_business_state`      | L'état métier                                              |
| `get_available_actions`   | Les actions disponibles                                    |
| `get_action_details`      | Le détail d'une action (et les preuves qui la mentionnent) |
| `get_relevant_evidence`   | Les preuves liées à une requête courte                     |
| `get_hypotheses`          | Les hypothèses                                             |
| `get_contradictions`      | Les contradictions                                         |
| `get_functional_coverage` | La couverture fonctionnelle                                |
| `get_previous_actions`    | Les étapes déjà faites                                     |
| `get_next_actions`        | Les étapes attendues                                       |

Aucun outil d'exécution n'existe (`click`, `fill`, `submit`, `delete`, `goto`, `execute…`,
`shell`, écriture de fichiers ou de base). Contrôles en profondeur :

1. Le client tourne en mode `empty` du SDK : aucun outil ambiant, aucune instruction ni
   configuration découverte.
2. `availableTools` liste uniquement les outils de lecture enregistrés.
3. `excludedTools` exclut `builtin:*` et `mcp:*`.
4. `onPermissionRequest` approuve un outil personnalisé enregistré, une seule fois. Il refuse
   shell, écriture, lecture de fichiers, URL et mémoire.
5. `onPreToolUse` refait le même contrôle et applique le budget d'outils.
6. Le registre refuse à l'enregistrement tout outil dont le nom désigne une action. Un ajout
   futur ne peut donc pas transformer le conseiller en exécutant par accident.

Ces contrôles protègent le **processus** ; la SafetyPolicy protège l'**application testée**,
seule juge des actions.

## 12. Budgets, pannes, délais

| Situation                                                     | Événement             | Suite                                                                    |
| ------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| Budget atteint (run, action, divergence)                      | `AI_BUDGET_EXHAUSTED` | Repli déterministe                                                       |
| SDK absent, non authentifié, modèle indisponible              | `AI_UNAVAILABLE`      | Repli déterministe ; arrêt du run seulement si `failOnUnavailable: true` |
| Pas de réponse dans `timeoutMs` (et `maxReasoningDurationMs`) | `AI_TIMEOUT`          | Repli ; la requête est annulée côté SDK                                  |
| Erreur du fournisseur                                         | —                     | `maxRetries` nouvelles tentatives, puis repli                            |

L'initialisation est **paresseuse** : le SDK n'est chargé qu'au premier appel réel. La
disponibilité est vérifiée une fois par run, et le client est arrêté à la fin du run, quoi qu'il
arrive.

## 13. Audit, événements, rapport, mesures

Chaque intervention laisse un enregistrement (`AI-n`) :

- contexte et déclencheur ;
- but ;
- confiance et action du déterministe ;
- proposition structurée, preuves citées, validation ;
- sûreté, décision, source ;
- résultat runtime ;
- latence et appels d'outils.

Aucune chaîne de pensée n'est demandée ni stockée.

**Événements** (`engine-log.jsonl`) :

- `AI_TRIGGER_EVALUATED`, `AI_REQUEST_CREATED`, `AI_REQUEST_SANITIZED`, `AI_SESSION_CREATED` ;
- `AI_PROPOSAL_RECEIVED`, `AI_PROPOSAL_VALIDATED`, `AI_PROPOSAL_REJECTED`, `AI_PROPOSAL_ACCEPTED` ;
- `AI_SHADOW_DISAGREEMENT`, `AI_FALLBACK_ACTIVATED` ;
- `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_BUDGET_EXHAUSTED` ;
- `AI_RUNTIME_CONFIRMED`, `AI_RUNTIME_CONTRADICTED`.

**Rapport HTML**, section « AI Intelligence ». Elle reprend le mode, le fournisseur et le modèle, puis les compteurs suivants :

- chemins rapides et appels ;
- propositions acceptées, rejetées, sans conclusion ;
- propositions confirmées ou contredites au runtime ;
- récupérations aidées par l'IA ;
- comparaisons shadow ;
- délais dépassés, replis, latence moyenne.

**Fichiers et sortie** :

- `reports/ai/intelligence.json` : le résumé et les 100 dernières interventions ;
- `result.json` (`ai`) et la console.

Ces mesures répondent à la question « Copilot améliore-t-il réellement QA-Crawler ? » :

- **ASSIST** mesure l'accord avec le déterministe, sans risque ;
- **HYBRID** compte les récupérations ajoutées, confirmées au runtime, et les propositions contredites.

## 14. Tests

Aucun test de la CI n'appelle Copilot : un **FakeIntelligenceProvider** scripté
(`tests/fixtures/fake-intelligence-provider.ts`) et un faux SDK remplacent le réseau.

- `tests/unit/ai-intelligence.test.ts` couvre :
  - les modes OFF, ASSIST et HYBRID, en confiance haute comme basse ;
  - les propositions rejetées : action inventée, action non sûre, fausse preuve, cible désactivée, schéma invalide, INCONCLUSIVE ;
  - les replis : fournisseur indisponible, délai dépassé, budget atteint ;
  - le nettoyage de la requête et l'absence de DOM ;
  - la confirmation et la contradiction au runtime ;
  - la trigger policy, la configuration, la CLI et l'environnement.
- `tests/unit/ai-copilot-provider.test.ts` (faux SDK) couvre :
  - l'initialisation paresseuse ;
  - la session `replace`, la sortie structurée, l'usage ;
  - la défense en profondeur et le budget d'outils ;
  - la mémoire de session périmée ;
  - SDK absent, non authentifié, modèle inconnu ;
  - le jeton : jamais dans un prompt ni dans une raison ;
  - le repli sans sortie structurée, l'arrêt.
- `tests/integration/ai-intelligence.test.ts` (navigateur réel, application qui change de version) :
  - **OFF** : la récupération déterministe bornée échoue, comme avant ;
  - **HYBRID** : le conseiller propose l'onglet « Enterprise Details ». La proposition est validée et jugée SAFE, puis exécutée ; les champs apparaissent et `AI_RUNTIME_CONFIRMED` est émis ; le parcours continue jusqu'à PASSED ;
  - **HYBRID faux** : le lien « Company Profile » est proposé ; l'objectif n'est pas atteint, `AI_RUNTIME_CONTRADICTED` est émis, l'étape n'est jamais PASS ;
  - **ASSIST** : la proposition est seulement mesurée ;
  - **non sûr** : le bouton qui écrit n'est jamais cliqué ;
  - **action inventée** : rejet avant le navigateur ;
  - **pannes** : fournisseur indisponible, délai dépassé, budget atteint ;
  - **exploration HYBRID** : chaque proposition retenue est vérifiée au runtime.
- `tests/integration/copilot-live.test.ts` est le contrat avec le **vrai** Copilot. Il est ignoré par défaut :

  ```bash
  QA_COPILOT_LIVE=1 npx vitest run --project integration tests/integration/copilot-live.test.ts
  ```

## 15. Docker et dépendance optionnelle

`@github/copilot-sdk` est une **dépendance optionnelle** (avec son runtime, environ 150 Mo). Sans
elle, ASSIST et HYBRID signalent `AI_UNAVAILABLE` (« @github/copilot-sdk is not installed ») et
QA-Crawler continue en déterministe. Image sans le SDK :

```bash
docker build --build-arg WITH_COPILOT_SDK=false -t qa-crawler .
```

## 16. Limites et évolutions

- Un seul conseiller (pas de multi-agent) ; d'autres conseillers spécialisés s'ajouteront derrière
  `IntelligenceProvider`, sans toucher au cœur : `UIUnderstandingAdvisor`, `BusinessRuleAdvisor`,
  `FailureAnalysisAdvisor`, `RecoveryAdvisor`, `CoverageAdvisor`.
- La récupération aidée par l'IA retient **une** action par divergence, et un plan proposé n'est
  pas encore exécuté pas à pas (il est validé et audité).
- L'analyse d'une erreur inconnue est consignée (catégorie probable, investigation SÛRE) ; le
  runtime et les oracles restent seuls juges.

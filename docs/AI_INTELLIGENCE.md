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
17. [Gestion des modèles Copilot](#17-gestion-des-modèles-copilot)

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
    modelSelection: # voir « Gestion des modèles » (§17)
      mode: ADAPTIVE # AUTO | EXPLICIT | ADAPTIVE
      # model: <id>              # EXPLICIT : un identifiant découvert pour ce compte
      defaultProfile: BALANCED # profil de la complexité MEDIUM
      profiles: # candidats facultatifs ; sans candidat : routage officiel (autoTier)
        FAST: { models: [], autoTier: efficiency }
        BALANCED: { models: [], autoTier: balance }
        INTELLIGENCE: { models: [], autoTier: intelligence }
    reasoning:
      mode: ADAPTIVE # AUTO (rien d'envoyé) | FIXED (default) | ADAPTIVE (selon la complexité)
      default: MEDIUM
      lowComplexity: LOW
      mediumComplexity: MEDIUM
      highComplexity: HIGH
      veryHighComplexity: HIGH
    fallback:
      enabled: true
      strategy: AUTO # AUTO | ALTERNATIVE | DETERMINISTIC
    discovery:
      cache: true
      ttlMs: 600000
      refreshOnUnavailableModel: true
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

| CLI                                                | Environnement                 | Effet                                            |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `--intelligence off\|assist\|hybrid`               | `QA_INTELLIGENCE_MODE`        | Mode (assist / hybrid active, off coupe)         |
| —                                                  | `QA_INTELLIGENCE_ENABLED`     | `ai.enabled`                                     |
| `--ai-provider copilot\|deterministic`             | `QA_INTELLIGENCE_PROVIDER`    | Fournisseur                                      |
| `--ai-model <id>`                                  | `QA_COPILOT_MODEL`            | Modèle Copilot (implique EXPLICIT)               |
| `--ai-model-selection auto\|explicit\|adaptive`    | `QA_COPILOT_MODEL_SELECTION`  | Mode de sélection du modèle                      |
| `--ai-reasoning auto\|adaptive\|low\|medium\|high` | `QA_COPILOT_REASONING_EFFORT` | Effort de raisonnement (low/medium/high : FIXED) |

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

## 17. Gestion des modèles Copilot

> Ne jamais utiliser le modèle le plus puissant pour tout ; ne jamais utiliser un LLM quand il
> n'est pas nécessaire ; ne jamais supposer qu'un modèle est disponible, ni ses capacités, ni
> qu'un effort de raisonnement est supporté. **Découvrir ce que Copilot rend réellement
> disponible**, puis adapter.

### Ce que le SDK installé expose réellement (`@github/copilot-sdk` 1.0.16)

| Besoin                    | API réelle utilisée                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Découverte                | `client.listModels()` → `ModelInfo[]` (mis en cache par le SDK jusqu'à la déconnexion)                                                                                                            |
| Capacités                 | `capabilities.supports.{vision, reasoningEffort}`, `capabilities.limits.{max_context_window_tokens, max_prompt_tokens, max_output_tokens}`, `supportedReasoningEfforts`, `defaultReasoningEffort` |
| Autorisation              | `policy.state` : `enabled` (utilisable), `disabled` (MODEL_NOT_AUTHORIZED), `unconfigured`                                                                                                        |
| AUTO officiel             | `createSession({ model: "auto", capi: { autoTier } })` avec `efficiency`, `balance`, `intelligence` (`fast` est réservé aux intégrateurs)                                                         |
| Changement de modèle      | `session.setModel(model, { reasoningEffort, autoTier })`                                                                                                                                          |
| Modèle réellement utilisé | l'événement `assistant.usage` (`data.model`, `data.reasoningEffort`)                                                                                                                              |

Le SDK ne dit **pas** si un modèle supporte les outils ou la sortie structurée : ces capacités
restent **inconnues** (jamais supposées vraies ou fausses) et n'excluent pas un modèle.

### Architecture

```
IntelligenceTriggerPolicy (faut-il un LLM ?)
        ▼
ReasoningComplexityAnalyzer (sans LLM) ── TRIVIAL → aucun appel, aucun choix de modèle
        ▼
ModelSelectionPolicy ── AUTO | EXPLICIT | ADAPTIVE (profil FAST / BALANCED / INTELLIGENCE)
   ├── AvailableModelRegistry (listModels, cache TTL, refreshModels)
   └── ModelCapabilityResolver (capacités déclarées, contexte nécessaire)
        ▼
ReasoningEffortPolicy (niveau voulu → niveau DÉCLARÉ par le modèle, sinon ajusté ou omis)
        ▼
ModelFallbackPolicy (AUTO | ALTERNATIVE | DETERMINISTIC — jamais masqué)
        ▼
ModelSelectionDecision → CopilotSessionFactory → Copilot Provider EXISTANT → SDK
        ▼
validation, SafetyPolicy, exécution, vérification au runtime (INCHANGÉES)
```

Code : `src/ai/models/` (types, registre, capacités, complexité, sélection, effort, repli). Le
fournisseur Copilot existant applique la décision ; la session factory reçoit le modèle, l'effort
et la préférence AUTO sans rien choisir elle-même.

### Complexité du raisonnement (sans LLM)

Le `ReasoningComplexityAnalyzer` lit ce que le moteur cognitif sait déjà :

- la confiance déterministe ;
- les actions plausibles ;
- les hypothèses ouvertes et concurrentes ;
- les contradictions ;
- la divergence du parcours ;
- les plans ou candidats de récupération ;
- les tentatives de récupération ;
- l'état métier inconnu ;
- le but ambigu et les préconditions manquantes ;
- l'échec non classé ;
- l'absence de preuves.

Chaque point de difficulté devient une **raison** lisible.

| Niveau    | Exemple                                                   | Profil (ADAPTIVE)           | Effort voulu |
| --------- | --------------------------------------------------------- | --------------------------- | ------------ |
| TRIVIAL   | but connu, une action, confiance 0,96                     | — (aucun LLM)               | —            |
| LOW       | petite ambiguïté entre deux libellés                      | FAST                        | LOW          |
| MEDIUM    | deux actions plausibles, hypothèses 0,58 / 0,55           | `defaultProfile` (BALANCED) | MEDIUM       |
| HIGH      | divergence + hypothèses + précondition inconnue           | INTELLIGENCE                | HIGH         |
| VERY_HIGH | divergence + contradictions + plans + état métier inconnu | INTELLIGENCE                | HIGH         |

### Modes de sélection

| Mode       | Comportement                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO`     | le routage officiel de Copilot (`model: auto`) ; QA-Crawler enregistre le mode, et le modèle effectif s'il est observé                                                                                      |
| `EXPLICIT` | le modèle demandé, **vérifié avant la session** (découvert ? autorisé ? contexte suffisant ?) ; sinon repli visible                                                                                         |
| `ADAPTIVE` | complexité → profil → premier candidat configuré, découvert, utilisable et compatible (de préférence un qui déclare l'effort voulu) ; sans candidat : `auto` avec la préférence du profil (`capi.autoTier`) |

Aucun modèle n'est écrit en dur, aucun classement n'est codé : seulement la configuration, les
capacités découvertes et la difficulté.

### Effort de raisonnement

`reasoning.mode` :

- `AUTO` : rien n'est envoyé ;
- `FIXED` : `default` ;
- `ADAPTIVE` : selon la complexité.

Le niveau n'est **envoyé** que si le modèle choisi le **déclare** :

| Cas                                      | Ce qui est envoyé                       |
| ---------------------------------------- | --------------------------------------- |
| HIGH demandé, `[low, medium]` déclarés   | MEDIUM — `AI_REASONING_EFFORT_ADJUSTED` |
| Le modèle ne déclare aucun effort        | rien n'est envoyé                       |
| Routage `auto` (modèle inconnu d'avance) | rien n'est envoyé (invérifiable)        |

### Replis (jamais masqués)

Les raisons de repli possibles :

- `MODEL_NOT_AVAILABLE`, `MODEL_NOT_AUTHORIZED`, `MODEL_CAPABILITY_MISMATCH` ;
- `MODEL_SESSION_CREATION_FAILED`, `MODEL_DISCOVERY_FAILED` ;
- `REASONING_EFFORT_UNSUPPORTED`, `MODEL_TEMPORARILY_UNAVAILABLE`.

La stratégie (`fallback.strategy`) décide de la suite :

| Stratégie       | Repli                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `AUTO`          | routage officiel                                                         |
| `ALTERNATIVE`   | un autre modèle découvert et compatible, dans l'ordre du SDK, sinon AUTO |
| `DETERMINISTIC` | aucune IA pour cet appel (`AI_MODEL_UNAVAILABLE`, décision déterministe) |

Un modèle introuvable dans un cache ancien déclenche **une** redécouverte avant le repli
(`refreshOnUnavailableModel`).

Le rapport distingue toujours trois modèles :

- `requestedModel` : demandé par la configuration, la CLI ou la politique ;
- `selectedModel` : choisi par la politique ;
- `effectiveModel` : réellement utilisé, **seulement s'il est observé** (`assistant.usage`), jamais déduit.

### Observabilité

**Événements :**

- `AI_NO_LLM_REQUIRED` ;
- `AI_MODEL_DISCOVERY_STARTED`, `AI_MODEL_DISCOVERY_COMPLETED`, `AI_MODEL_DISCOVERY_FAILED` ;
- `AI_MODEL_SELECTED`, au format `[AI] trigger=… complexity=… mode=… profile=… model=… reasoning=…` ;
- `AI_MODEL_UNAVAILABLE`, `AI_MODEL_FALLBACK`, `AI_MODEL_CAPABILITY_MISMATCH` ;
- `AI_REASONING_EFFORT_SELECTED`, `AI_REASONING_EFFORT_ADJUSTED` ;
- `AI_EFFECTIVE_MODEL_OBSERVED`.

**Audit, par intervention** (`modelContext`) :

- mode de sélection ;
- complexité et ses raisons ;
- profil ;
- modèles demandé, choisi et effectif ;
- préférence AUTO ;
- efforts demandé, envoyé et rapporté ;
- repli et sa raison.

**Rapport** (section « AI Intelligence ») :

- mode de sélection, profil par défaut, état de la découverte ;
- interventions sans LLM ;
- replis de modèle ;
- répartition de l'effort envoyé et de la complexité ;
- tableau « Models used (observed, not ranked) » ;
- tableau « Effectiveness by trigger and complexity » (efficacité par modèle, déclencheur et complexité).

Le tableau « Models used » donne, par modèle :

- appels ;
- propositions acceptées, rejetées, sans conclusion ;
- confirmations et contradictions au runtime ;
- délais dépassés, replis ;
- latence moyenne ;
- récupérations résolues.

Une proposition acceptée puis **contredite** au runtime n'est jamais comptée comme un succès. Le
taux de confirmation n'est calculé qu'à partir de **5** vérifications : en dessous, « too few
samples ». Ces statistiques sont observationnelles et par run ; elles ne pilotent jamais la
sélection.

### Configuration

```yaml
ai:
  enabled: true
  mode: HYBRID
  copilot:
    modelSelection: { mode: EXPLICIT, model: '<available-model-id>' } # ou mode: AUTO / ADAPTIVE
    reasoning: { mode: ADAPTIVE }
```

```bash
npm run qa -- mission.yaml --intelligence hybrid --ai-model <model-id>                 # EXPLICIT
npm run qa -- mission.yaml --intelligence hybrid --ai-model-selection auto
npm run qa -- mission.yaml --intelligence assist --ai-model-selection adaptive --ai-reasoning high
```

Les anciennes clés `ai.copilot.model`, `reasoningEffort` et `adaptiveReasoning` sont migrées
automatiquement, avec un avertissement.

**Mode OFF** : aucun client, aucune découverte, aucune sélection, aucune résolution d'effort,
aucune session, aucune activité réseau. C'est vérifié par les tests.

### Tests

- `tests/unit/ai-model-selection.test.ts` (21 tests) couvre :
  - le registre : découverte, cache TTL, rafraîchissement, échec de découverte, capacités jamais inventées ;
  - la complexité : TRIVIAL, MEDIUM, VERY_HIGH ;
  - la sélection : EXPLICIT vérifié, EXPLICIT indisponible (repli visible, désactivé, alternative), contexte insuffisant, ADAPTIVE (profils, candidats), AUTO ;
  - l'effort : ajusté ou omis ;
  - la session : ouverte avec la décision ; aucune session au modèle inexistant ; session refusée ;
  - la découverte en échec (AUTO ou déterministe) ;
  - le modèle effectif observé ou laissé indéfini ;
  - `setModel` sur une session réutilisée ;
  - le mode OFF ;
  - le cas TRIVIAL sans appel ;
  - les mesures par modèle (une contradiction n'est pas un succès) ;
  - la configuration, la CLI, l'environnement et la migration.
- `tests/integration/ai-model-selection.test.ts` (navigateur réel, SDK simulé à la forme réelle) :
  - une divergence profonde choisit le modèle du profil INTELLIGENCE avec l'effort HIGH ; le runtime confirme, et l'audit est tenu par modèle ;
  - un modèle EXPLICIT inexistant se replie sur `auto`, de façon visible, et le parcours se termine.

## 18. Cycle de vie d'une décision IA

Chaque appel au conseiller a un cycle de vie entièrement traçable :

```
TRIGGER → CONTEXT → CALL → RAW RESULT → PARSED PROPOSAL → VALIDATION → ARBITRATION
→ DECISION → (EXECUTION) → RUNTIME VERIFICATION → KNOWLEDGE UPDATE
```

Le cycle permet de répondre, pour chaque décision `AI-00017` :

- pourquoi Copilot a été appelé ;
- ce qu'il a proposé ;
- si la proposition était valide ;
- pourquoi elle a été retenue ou non ;
- pourquoi il y a eu un repli ;
- si elle a aidé l'objectif fonctionnel ;
- ce que QA-Crawler en a appris.

### Audit : « 10 calls, 0 accepted, 0 rejected, 11 fallbacks »

Le chemin réel d'un appel :

```
IntelligenceTriggerPolicy → IntelligenceGateway → CopilotIntelligenceProvider → SDK
→ réponse → validateIntelligenceProposal → arbitrate → IntelligenceAuditTrail → rapport
```

L'information était perdue à la fin de ce chemin, dans les compteurs de l'audit :

- **Les replis étaient mal comptés.** Un repli était défini comme `!accepted && outcome !== NO_LLM_REQUIRED`.
  - En ASSIST, `accepted` vaut toujours `false`. Chaque proposition shadow, même valide, comptait donc comme un « repli ».
  - Chaque décision émettait aussi `AI_FALLBACK_ACTIVATED`.
- **Une décision sans appel s'ajoutait.** `calls` exclut les décisions sans appel : budget épuisé, fournisseur ou modèle indisponible. `fallbacks` les comptait.
  - Le budget `ai.budgets.maxCallsPerRun` vaut 10 par défaut. Le 11ᵉ besoin d'aide devient une décision `AI_BUDGET_EXHAUSTED` : un repli sans appel.
  - D'où 10 appels et 11 « replis ».
- **Aucun appel n'était compté deux fois.** Les compteurs mesuraient donc autre chose que ce qu'ils affichaient.
- **`0 rejected` voulait dire seulement « aucune réponse invalide ».** Les 10 réponses étaient des propositions shadow, des réponses sans conclusion, des délais dépassés ou des erreurs. Le rapport ne les détaillait pas.

### Un appel, une issue

Chaque décision porte un `lifecycle` (voir `src/ai/decision-lifecycle.ts`). Ses dimensions sont séparées :

| Dimension                                | Valeurs                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response`                               | `PROPOSAL`, `INCONCLUSIVE`, `NEED_MORE_EVIDENCE`, `INVALID_RESPONSE`, `TIMEOUT`, `ERROR`, et sans appel : `UNAVAILABLE`, `BUDGET_EXHAUSTED`, `NO_LLM_REQUIRED`                                                                                                                   |
| `terminal`                               | exactement une issue : `ACCEPTED`, `SHADOW_ONLY`, `SAFETY_REJECTED`, `VALIDATION_REJECTED`, `PROPOSAL`, `INCONCLUSIVE`…                                                                                                                                                          |
| `proposalValid` / `acceptedForExecution` | jamais confondus (en ASSIST : valide, mais jamais retenue pour exécution)                                                                                                                                                                                                        |
| `shadowResult` (ASSIST)                  | `AGREEMENT`, `DISAGREEMENT`, `AI_INCONCLUSIVE`, `DETERMINISTIC_ONLY`, `AI_ONLY_CANDIDATE`                                                                                                                                                                                        |
| `fallbackReason`                         | `AI_INCONCLUSIVE`, `AI_NEED_MORE_EVIDENCE`, `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_ERROR`, `INVALID_PROPOSAL`, `UNKNOWN_ACTION`, `INVALID_EVIDENCE`, `SAFETY_BLOCKED`, `BUDGET_EXHAUSTED`, `MODEL_UNAVAILABLE`, `LOW_AI_CONFIDENCE`, `DETERMINISTIC_PRIORITY`, `NO_USEFUL_PROPOSAL` |
| `notExecutedReason`                      | `ASSIST_MODE`, `ADVISORY_ONLY`, `SAFETY_BLOCKED`, `DETERMINISTIC_PRIORITY`…                                                                                                                                                                                                      |
| `runtime`                                | `CONFIRMED`, `CONTRADICTED`, `NOT_APPLICABLE`, `PENDING`                                                                                                                                                                                                                         |
| `knowledge`                              | `AI_PROPOSED_HYPOTHESIS`, `RUNTIME_SUPPORTED`, `RUNTIME_CONTRADICTED`                                                                                                                                                                                                            |
| `goalProgress`                           | avancement de l'objectif avant → après l'action proposée                                                                                                                                                                                                                         |

**ASSIST n'est pas un repli.** Un repli signifie qu'un chemin IA attendu n'a pas pu servir. Une proposition valide en ASSIST est `SHADOW_ONLY`, avec `notExecutedReason=ASSIST_MODE`.

**Contrôle des compteurs.** Sur les appels réels, la somme des `response` vaut `calls`. Chaque repli cite les décisions qui l'ont produit (`fallbacks.decisionIds`). Un écart est signalé `INCONSISTENT` dans le rapport.

Une trace par décision (`AI_DECISION_CLASSIFIED`) :

```
[AI AI-00017] trigger=UNKNOWN_BLOCKING_PRECONDITION context=BLOCKED_GOAL mission=CREATE_REQUEST
goal=CREATE_REQUEST_DONE checkpoint=CREATE_REQUEST_READY missing=UNKNOWN deterministicConfidence=0.41
model=… mode=ASSIST response=PROPOSAL proposal.action=A31 proposal.hypothesis=WORKFLOW_PRECONDITION
proposal.precondition=FINAL_APPLY_REQUIRED proposal.confidence=0.74 validation=VALID
shadow=AI_ONLY_CANDIDATE terminal=SHADOW_ONLY execution=NOT_EXECUTED_ASSIST_MODE
```

### Le contexte fonctionnel envoyé à Copilot

`IntelligenceContextBuilder` ajoute `functionalContext` à chaque requête. Ce contexte vient du moteur cognitif ; il est nettoyé comme le reste et ne contient aucune valeur saisie. Il comprend :

- l'objectif courant et l'objectif parent ;
- l'avancement de l'objectif ;
- les préconditions satisfaites et manquantes ;
- les raisons du blocage ;
- le dernier checkpoint confirmé et le suivant attendu ;
- les relations causales ;
- les actions confirmées et attendues ;
- les cibles des actions suivantes du parcours humain (`NEXT_ACTION_TARGET_AVAILABLE` est un effet attendu vérifiable) ;
- la couverture fonctionnelle ;
- la première divergence fonctionnelle ;
- une question cognitive.

Le conseiller peut ainsi répondre « cette action satisfera la précondition X et fera avancer l'objectif Y », et pas seulement « cette action ressemble à… ». Le schéma de proposition accepte :

- `hypothesis.type` (`WORKFLOW_PRECONDITION`, `CAUSAL`, `SEMANTIC_CHECKPOINT`…) ;
- `missingPrecondition` ;
- `workflowPhase` ;
- les effets attendus `CHECKPOINT` et `NEXT_ACTION_TARGET_AVAILABLE`.

### Objectif bloqué : « submission READY, blocked »

- **Ce qui manquait.** La mission n'était jamais atteinte, même après un envoi réussi : la condition `MISSION_DONE` ne recevait jamais l'effet confirmé. C'est corrigé.
- **`BlockedGoalAnalysis`.** Elle s'appuie sur le PreconditionResolver et dit pourquoi l'objectif est bloqué :
  - les préconditions satisfaites (par exemple `CREATE_REQUEST_READY`) ;
  - les préconditions manquantes ;
  - les raisons, par exemple « l'action d'envoi n'a pas été exécutée et confirmée », ou « l'envoi a échoué (classe d'échec) » ;
  - les actions et hypothèses candidates ;
  - les checkpoints ;
  - une confiance.
- **Cause inconnue.** Si le moteur ne sait pas pourquoi l'objectif reste bloqué, la précondition manquante vaut `UNKNOWN`. Exemples : l'envoi a été fait sans écriture acceptée, ou aucun envoi n'a été démontré.
- **Déclencheur `UNKNOWN_BLOCKING_PRECONDITION`.** En fin de flow, il appelle le conseiller dans un contexte d'analyse `BLOCKED_GOAL`. Rien n'y est exécuté. La proposition devient une `AI_PROPOSED_HYPOTHESIS`, que le HypothesisEngine juge ensuite.

### Avancement, première divergence, couverture expliquée

- **GoalProgressEvaluator.** Il mesure l'avancement à partir des préconditions satisfaites, des checkpoints confirmés et de l'état métier, jamais de l'URL seule. Le rapport montre `before → after` à chaque changement, et pour chaque action proposée par l'IA exécutée.
- **FIRST FUNCTIONAL DIVERGENCE.** C'est la première étape dont l'effet attendu manque, est faux, a demandé une récupération, ou a échoué. Ce n'est pas forcément la dernière erreur Playwright.
  - L'analyse d'un échec envoie cette divergence au conseiller.
  - Chaque échec classé porte un `FailureContext` : objectif touché, checkpoint atteint, attendu, observé.
- **Couverture `UNREACHABLE` / `BLOCKED`.** Elle est expliquée par :
  - la raison ;
  - le dernier checkpoint ;
  - l'objectif bloquant ;
  - les préconditions manquantes ou inconnues ;
  - la première divergence ;
  - les preuves ;
  - l'hypothèse IA éventuelle.

  L'IA ne transforme jamais `UNREACHABLE` en `REACHED` : seul le runtime le peut.

### Connaissance

- **Le détail de chaque hypothèse.** Le rapport et `cognitive/hypotheses.json` montrent :
  - le type et l'origine (`AI_PROPOSAL`, `HUMAN_RECORDING`, `RUNTIME`…) ;
  - la description ;
  - les preuves pour et contre ;
  - la confiance et le statut ;
  - les dates de création et de dernière évaluation ;
  - la décision IA d'origine.
- **Une hypothèse contredite ne disparaît pas.** Le rapport dit pourquoi elle l'a été, quelles alternatives existent, et quelle investigation SÛRE l'apprentissage actif propose. Sans alternative ni investigation, le déclencheur `HYPOTHESIS_ANALYSIS` peut demander une autre explication au conseiller.
- **Une affirmation de LLM n'est jamais confirmée seule.** En revanche, le runtime peut maintenant la contredire (`CONTRADICTED`, puis `REJECTED`). Avant, elle restait `HYPOTHESIS` quoi qu'il arrive.

### Recording Intelligence (PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST)

Après `qa-crawler record`, avec `ai.mode` ASSIST ou HYBRID, `RecordingIntelligenceEnricher` :

1. fait l'enrichissement déterministe (phases, dépendances, intention, checkpoints) ;
2. si le sens reste ambigu (action non comprise, aucune intention métier, aucune dépendance), appelle le conseiller (`RECORDING_ENRICHMENT`, contexte `RECORDING`).

Le conseiller peut proposer :

- un objectif fonctionnel ;
- une phase ;
- une intention ;
- un checkpoint ;
- une précondition ;
- une relation causale ;
- un invariant.

Le conseiller ne peut jamais :

- supprimer, réordonner ou inventer une action humaine ;
- modifier une valeur ou une classification ;
- modifier le flow ;
- déclarer une causalité CONFIRMED.

L'empreinte des actions humaines est vérifiée avant et après l'enrichissement. Tout candidat porte `origin=AI_PROPOSAL`, `sourceRecording`, `runtimeConfirmed=false` et `status=PROPOSED`. Le résultat est écrit dans `recording-intelligence.json` et dans la section « Recording intelligence » du rapport d'enregistrement.

Selon le mode :

- **ASSIST** : des candidats shadow seulement.
- **HYBRID** : les relations observables (« click X révèle le champ Y ») sont gardées hors du dépôt, dans `knowledge/ai-recording-candidates.json`. Au rejeu, elles deviennent des hypothèses que le runtime soutient (effet observé) ou contredit (effet absent), jamais des vérités.

### Artefacts et rapport

- **`reports/intelligence-decisions.json`.** Chaque décision y figure avec :
  - `decisionId`, `timestamp`, `trigger`, `mode` et `model` ;
  - `functionalContextSummary`, `goal` et `blockingReason` ;
  - `requestSummary` et `proposal` ;
  - `validation` et `shadowResult` ;
  - `fallbackReason` et `executionResult` ;
  - `runtimeVerification` et `knowledgeImpact`.

  Le fichier est nettoyé : aucun secret, jeton, mot de passe, en-tête `Authorization` ni cookie.

- **La section « AI decisions — lifecycle » du rapport.** Elle détaille :
  - les appels par déclencheur ;
  - les réponses ;
  - les décisions sans appel ;
  - la validation et le shadow ;
  - les exécutions et leurs raisons ;
  - le runtime (« sans objet en ASSIST ») ;
  - les replis par raison, avec leurs décisions ;
  - l'apport à la connaissance ;
  - le contrôle des compteurs.
- **`cognitive/functional-reasoning.json`.** Il contient l'objectif bloqué, l'avancement, les divergences, les envois tentés et les candidats d'enregistrement.
- **Déclencheurs configurables :**

```yaml
ai:
  triggers:
    unknownBlockingPrecondition: true # objectif bloqué, cause inconnue
    hypothesisAnalysis: true # hypothèse contredite sans alternative
    recordingEnrichment: true # enrichissement après un enregistrement
```

### Tests

- `tests/unit/ai-decision-lifecycle.test.ts` couvre :
  - la reproduction de l'audit (10 appels ASSIST, puis budget épuisé : 10 `SHADOW_ONLY` et 1 repli `BUDGET_EXHAUSTED`) ;
  - la cohérence des compteurs sur des réponses mélangées ;
  - ASSIST en désaccord (valide, `DISAGREEMENT`, non retenue, `ASSIST_MODE`, aucun repli) ;
  - INCONCLUSIVE (un seul repli) ;
  - HYBRID retenue puis confirmée avec avancement ;
  - une proposition fausse, contredite ;
  - SafetyPolicy et priorité déterministe ;
  - l'analyse d'objectif bloqué et le contexte fonctionnel ;
  - un délai dépassé ;
  - l'artefact nettoyé.
- `tests/unit/functional-reasoning.test.ts` couvre :
  - le cas réel (READY mais bloqué, puis cause inconnue) ;
  - la mission atteinte après un envoi accepté ;
  - l'avancement ;
  - la première divergence ;
  - le `FailureContext` ;
  - une hypothèse IA contredite au runtime, puis analysée ;
  - la confirmation ou la contradiction au rejeu des candidats d'enregistrement.
- `tests/unit/recording-intelligence.test.ts` couvre :
  - toutes les actions humaines gardées, à l'identique ;
  - aucune valeur saisie envoyée ;
  - des candidats `PROPOSED` ;
  - le mode HYBRID ;
  - le mode OFF.
- `tests/integration/ai-blocked-goal.test.ts` (navigateur réel, Copilot simulé) : formulaire prêt, envoi sans effet. Le test vérifie :
  - `UNKNOWN_BLOCKING_PRECONDITION` avec le contexte fonctionnel ;
  - une décision `SHADOW_ONLY` sans repli ;
  - une hypothèse IA ;
  - des compteurs cohérents ;
  - la trace et le rapport.

# Investigation IA des incidents

Le module `src/incident/ai` ajoute à Incident Reconstruction une investigation menée par des agents, sans rien changer à
la règle du moteur : **une cause n'est confirmée que par le validateur déterministe**, à partir de vérifications
réelles. Tout ce qu'un agent produit est une proposition datée, bornée et attribuée.

## Modes et profondeurs

| Mode            | Ce qui tourne                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `DETERMINISTIC` | Défaut. Aucun module IA chargé, aucun fournisseur créé, aucun appel réseau.                     |
| `AI_ASSISTED`   | Une passe de chaque agent, outils en lecture seule, sorties fusionnées comme propositions.      |
| `AI_AGENTIC`    | Boucle bornée ; les vérifications sans effet de bord déjà permises sont lancées par le service. |

| Profondeur | Portée                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `QUICK`    | Preuves essentielles, erreurs principales, hypothèses initiales.                                       |
| `STANDARD` | Trois couches, corrélation, vérifications ciblées, hypothèses alternatives, mémoire et couverture.     |
| `DEEP`     | `AI_AGENTIC` seulement : stratégies, contradictions, expériences générées, boucle adaptative, reprise. |

Configuration : `ai.incidents` (`mode`, `provider`, `model`, `timeoutMs`, `maxRetries`, `maxTurnsPerAgent`, `budget`,
`dataPolicy`) dans la section `ai` d'une configuration QA-Crawler, transmise au serveur par `SdkServerOptions.ai`
(`src/incident/ai/config.ts` valide et borne tout ; `ai.enabled: false` éteint tout). `resolveIncidentAiSettings` rend
`DETERMINISTIC` avec la raison quand le fournisseur, le modèle, la politique de données ou le secret manque ; la raison ne
contient jamais une valeur de l'environnement.

## Agents et outils

Agents (`src/incident/ai/agents`) : PLANNER, EVIDENCE_ANALYSIS, FRONTEND, BFF, BACKEND, CROSS_LAYER, HYPOTHESIS,
VERIFICATION_PLANNING, CONTRADICTION_HUNTER, SYNTHESIS, ASSISTANT. Chacun décrit ses outils permis, ses instructions
(en anglais, courtes) et son schéma de sortie (zod, puis JSON Schema transmis au modèle). La boucle
(`loop.ts`) fait tourner le modèle, passe chaque appel d'outil par le registre, valide la sortie finale (schéma puis
références existantes : une référence inconnue est rejetée, un seul nouvel essai avec les raisons, puis l'étape est en
échec).

Outils (`tools.ts`, liste fermée dans `agent.ts`) : `get_incident_summary`, `get_evidence`, `get_request`,
`get_trace_graph`, `get_graph_neighbours`, `find_symbol`, `find_references`, `search_code`, `read_source`,
`list_files`, `propose_experiment`, `request_scope_extension`, `git_changes`, `get_investigation_memory`. Chaque appel :
validation zod → opérations de politique → `ScopePolicy.check` pour chacune → lecture → masquage → bornes → donnée
délimitée (`===DATA … ===END DATA===`). Un nom portant un verbe d'exécution est refusé à la création du registre.
Aucun outil n'exécute de commande ; `git_changes` lance le binaire `git` avec des arguments fixes, sans interpréteur,
seulement si `scope.permissions.readGitHistory` est vrai et `git` figure dans `allowedCommands`.

## Ce que le serveur écrit

- `investigation.ai.runs[]` : le run (`RUNNING` puis `DONE`, `PARTIAL`, `FAILED`, `CANCELLED` avec `stopReason`), son
  plan, ses agents, ses constats (références et emplacements validés), ses propositions, ses demandes d'extension, sa
  synthèse, sa consommation et ses limites. La progression est servie depuis la mémoire du serveur sans changer la
  révision ; la fin fusionne : hypothèses `hyp-ai-<n>` (`origin: 'AI'`, `PROPOSED`, confiance ≤ 0,7, une règle du même
  titre l'emporte), arêtes `INFERRED` (raison « IA : … »), extensions `PENDING`.
- `investigation.ai.answers[]` : les réponses de l'assistant (références citées, ou la raison de l'absence de réponse).
- `incidents/<id>/ai/memory.json` : la mémoire d'investigation (stratégies, explorations, contradictions, expériences
  générées, couverture, permissions, chronologie structurée, limites, point de reprise). Validée à la lecture ; une
  mémoire illisible donne une mémoire neuve et une limite dans le run. Jamais de transcription, de corps de charge ni de
  secret.

## Décisions des personnes

- Une vérification proposée sans effet de bord et déjà permise peut être lancée par la boucle (`AI_AGENTIC`) par
  `service.planExperiment` puis `service.runExperiment` ; toute autre attend `POST …/ai/experiments/:e/decision`
  (`DECIDE`) ; approuver planifie et lance par le chemin ordinaire (`RUN_WRITES` exigé pour des effets de bord).
- Une extension de périmètre demandée par un agent reste `PENDING` jusqu'à une décision.
- Un budget plus petit que la configuration est permis au lancement ; plus grand, jamais : `POST …/ai/extend-budget`
  (`DECIDE`) prolonge la mémoire, borné, tracé (`extensions[]`).
- Pause, reprise, annulation : `POST …/ai/pause`, `/ai/resume`, `/ai/cancel` ; l'acquis est toujours conservé.

## Investigation approfondie (DEEP)

`deep/strategies.ts` découvre et priorise les stratégies (catalogue, dérivées des constats et contradictions ; gain
d'information attendu, jamais un score de certitude) ; `deep/experiments.ts` génère les expériences avec leurs
opérations exactes, évaluées par la politique avant d'être dites exécutables (refus, effets de bord, nature inconnue de
l'environnement ⇒ approbation nécessaire ; rien de destructif ; une expérience identique n'est pas répétée sans
justification) ; `agents/contradiction-hunter.ts` conteste les conclusions (une contradiction cite une référence ou est
une question ouverte) ; `deep/exploration.ts` donne aux hypothèses leur rôle (`CONFIRMED_CAUSE` seulement quand le moteur
dit `CONFIRMED` ; une hypothèse soutenue n'en écarte jamais une autre) ; `deep/coverage.ts` compte par dimension avec un
dénominateur explicite ; `deep/stopping.ts` continue tant qu'une stratégie utile ou une contradiction décisive existe et
qu'il reste du budget, jamais parce qu'un score est haut ; `deep/orchestrator.ts` tient la boucle, la mémoire, la pause
et la reprise.

## Tests

- Unitaires : agents (client scripté, outils réels sur la fixture), boucle, budget, fusion, exploration, politique
  d'arrêt, service (`tests/unit/incident-ai-service.test.ts` : run de bout en bout, hypothèse IA plafonnée, proposition
  lancée, mémoire, décision, prolongation, annulation, mode DETERMINISTIC sans module).
- Intégration (`tests/integration/incident-ai-investigation.test.ts`) : serveur réel, routes et droits, rapport, puis le
  sous-onglet « Investigation IA » dans Chromium (mode, profondeur, progression, constats, vérifications, origine des
  hypothèses, sans défilement global).

Aucun test n'appelle un fournisseur réel : le client de modèle est scripté (`tests/fixtures/scripted-model-client.ts`).

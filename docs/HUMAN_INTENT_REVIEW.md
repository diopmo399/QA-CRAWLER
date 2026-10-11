# Revue humaine des intentions d'action

L'analyse d'un enregistrement donne à chaque action une **interprétation** (`SEARCH`, `CREATE`,
`RETRIEVE`…). Elle peut se tromper. La revue humaine permet de la corriger, de la confirmer ou de la
réinitialiser depuis l'onglet **Analyse** de la fenêtre du Recorder, sans jamais toucher à ce qui a
été observé.

## Principe

```
interprétation automatique   (ActionView.interpretation + confidence — jamais modifiées)
        ↓
revue humaine                (une DÉCISION : CORRECT, CONFIRM, RESET — registre en ajout seul)
        ↓
interprétation finale        (ActionView.review.finalIntent, avec sa source et son statut)
```

- **Une seule liste d'intentions** : celle du modèle de l'application (`BUSINESS_ACTION_KINDS` :
  `SELECT_TASK`, `SWITCH_CONTEXT`, `NAVIGATE`, `CREATE`, `SEARCH`, `FILTER`, `OPEN`, `RETRIEVE`,
  `UPDATE`, `SAVE`, `DELETE`, `SUBMIT`), plus `UNKNOWN`. Aucun système parallèle.
- **La décision porte sur le SENS seulement.** L'action enregistrée, sa cible, ses sélecteurs, le
  DOM, le réseau, les observations et `generated.flow.yaml` ne changent pas : le rejeu exécute la
  même action physique sur la même cible.
- **Rien n'est effacé.** Les décisions forment un registre (`human-review.json`) ; une
  réinitialisation est une décision de plus, l'historique reste complet.
- **Confiance ≠ provenance.** La confiance initiale de l'analyse est gardée telle quelle ; la
  décision humaine est une _source_ (`HUMAN`), pas un nouveau pourcentage.

## Dans la fenêtre

La carte **Actions et intentions** (onglet Analyse) montre chaque action : libellé (« Cliquer sur
"Search" »), intention finale, source (`SYSTEM`, `👤 HUMAN`, `👤 HUMAN CONFIRMED`), confiance. Après une
correction : l'intention d'origine et sa confiance initiale, la justification, l'historique.

- **Modifier l'intention** — ouvre l'éditeur : choix de l'intention, justification facultative
  (500 caractères au plus), _Confirmer_ ou _Annuler_ (Annuler ne change rien).
- **Confirmer** — garde l'interprétation automatique et la marque `HUMAN_CONFIRMED`.
- **Réinitialiser l'interprétation** — revient à l'interprétation automatique ; la décision annulée
  reste dans l'historique.

Une intention hors de la liste, une action inconnue ou une réinitialisation sans décision en vigueur
sont refusées sans effet (le message s'affiche dans la fenêtre).

## Statuts et autorité

| Statut            | Source   | Signification                                           |
| ----------------- | -------- | ------------------------------------------------------- |
| `INFERRED`        | `SYSTEM` | interprétation automatique (aucune décision en vigueur) |
| `HUMAN_CORRECTED` | `HUMAN`  | l'humain a choisi une autre intention                   |
| `HUMAN_CONFIRMED` | `HUMAN`  | l'humain a confirmé l'interprétation automatique        |

Ordre d'autorité (`INTERPRETATION_AUTHORITY`) : `HUMAN_CONFIRMED` > `HUMAN_CORRECTED` >
`DETERMINISTIC_INFERENCE` > `AI_INFERENCE` > `UNKNOWN`. La décision en vigueur est la dernière d'une
action, sauf si c'est un `RESET`.

**L'IA ne remplace jamais une décision humaine.** Quand une nouvelle analyse (règles ou IA, après
l'arrêt) produit une interprétation différente d'une décision en vigueur, elle est gardée comme
`review.proposal` (source `AI_PROPOSAL` ou `SYSTEM`) et affichée comme proposition ; l'intention
finale reste celle de l'humain.

## Preuves

Chaque décision devient une preuve du modèle (`model.evidence`, `source: 'HUMAN'`, `kind`
`INTENT_CORRECTION`, `INTENT_CONFIRMATION` ou `INTENT_RESET`), reliée à l'action. Les compteurs
`summary.actions.humanCorrected` / `humanConfirmed` sont tenus à jour. Événement :
`RECORDING_INTENT_REVIEWED`.

## Mémoire

Avec `recording.knowledge: true`, la décision est gardée dans la mémoire fonctionnelle
(`intentDecisions`) **avec son contexte** : page, rôle, élément, sélecteur, étape métier. Portée
`CONTEXTUAL` : elle ne devient jamais une règle globale (« tout bouton Search est un SEARCH »). Une
réinitialisation retire l'entrée. Sans mémoire, rien n'est écrit hors du dossier de
l'enregistrement.

## Fichiers

- `human-review.json` — le registre : `{ version: 1, recordingSessionId, decisions[] }`, chaque
  décision avec `id`, `subject` (`kind: ACTION_INTENT`, `actionId`, `stepIds`), `type`,
  `previousIntent`, `newIntent`, `systemIntent`, `systemConfidence`, `reason`, `at`, `context`.
- `application-model.json` — chaque action revue porte `review` (statut, source, intention finale,
  intention et confiance d'origine, correction, proposition, historique).
- `index.html` — section **Interpretation review (human)** : intention finale, intention d'origine,
  source / statut, confiance initiale, correction, historique.

## Extensible

Le sujet d'une décision a un genre (`ReviewSubjectKind`). Seul `ACTION_INTENT` est implémenté ; les
genres `BUSINESS_ENTITY`, `BUSINESS_ATTRIBUTE`, `IDENTITY_CANDIDATE`, `SEMANTIC_MAPPING`,
`RELATIONSHIP` et `ACTION_CLASSIFICATION` sont réservés et passeront par le même registre.

## Limites

- Seule l'intention d'une action se corrige aujourd'hui (pas d'écran pour les autres sujets).
- Une correction choisit **une** intention ; une interprétation composée (`SWITCH_CONTEXT + CREATE`)
  ne se garde telle quelle que par _Confirmer_.
- Le rejeu ne lit pas les intentions : il rejoue l'action physique enregistrée.
- La mémoire garde les décisions ; elle ne les propose pas encore automatiquement dans un nouvel
  enregistrement.

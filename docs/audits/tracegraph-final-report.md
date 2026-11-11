# TraceGraph V2 — rapport final

Branche `feat/tracegraph-v2` (depuis `main` `d0f1e66`). Un seul agent, travail séquentiel, aucun LLM
dans le moteur, aucun Playwright ni test de bout en bout pour reconstruire les parcours, aucune
application importée modifiée.

## Phases

| Phase                      | Statut                                                                                                                               | Où                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 0 Audit et référence       | fait                                                                                                                                 | `docs/audits/tracegraph-baseline.md`               |
| 1 Trois graphes            | fait comme trois lectures d'un même modèle (natures), pas trois stockages                                                            | `docs/architecture/tracegraph-engine-v2.md`        |
| 2 Réconciliation des liens | fait (UNRESOLVED gardé, causes, preuves, API, onglet) ; INVALIDATED non représenté                                                   | `docs/architecture/link-reconciliation.md`         |
| 3 Résolution TypeScript    | partiel : identité de classe par fichier, imports et alias ; pas de TypeChecker                                                      | `src/static-analysis/class-identity.ts`            |
| 4 Causalité réactive       | partiel : installation d'abonnement distincte, parcours orientés par le flux ; pas d'évaluation VRAI / FAUX / INCONNU des conditions | `docs/architecture/reactive-causality-resolver.md` |
| 5 Contexte et conditions   | existant réutilisé (contextes d'appel `⟨type='X'⟩`) ; rien de nouveau                                                                | —                                                  |
| 6 Angular → BFF → Backend  | non modifié (corrélation existante) ; chemin de retour des données non traité                                                        | —                                                  |
| 7 Vérification ciblée      | conception seulement                                                                                                                 | `docs/architecture/targeted-verification.md`       |
| 8 Performance et budgets   | mesuré sur fixtures ; budgets FAST / BALANCED / DEEP non faits                                                                       | `docs/benchmarks/tracegraph-performance.md`        |
| 9 Persistance              | inchangée (JSON) ; version d'analyseur relevée                                                                                       | `src/cartography/scan.ts`                          |
| 10 Vues Dashboard          | onglet « Liens non résolus » ; Parcours & Graphe orienté par le flux                                                                 | `src/sdk/ui/dashboard-cartography-unresolved.ts`   |
| 11 Non-régression          | voir « Vérifications »                                                                                                               | —                                                  |
| 12 Benchmarks              | fixtures du dépôt seulement                                                                                                          | `docs/benchmarks/tracegraph-performance.md`        |
| 13 Rapport                 | ce document                                                                                                                          | —                                                  |

## Résultats mesurés (fixture `tracegraph`)

- Relations perdues sans trace sur les six fixtures : 10 → 0 (7 gardées comme non résolues, 2
  résolues, 1 lecture de corps scalaire abandonnée car sans objet).
- Composants homonymes : 1 gardé → 2 gardés, chacun avec sa route.
- Faux lien `submit` → `OrderApi#list` : présent → absent.
- `ngOnInit` : relie désormais l'installation de ses deux abonnements.
- Temps de scan : écarts de quelques millisecondes (21 → 25 ms médian), voir le benchmark.

## Vérifications exécutées

- `tests/unit/tracegraph-v2.test.ts` : 15 tests (identité, alias, lien non résolu et sa preuve,
  sélection et rendu de l'onglet, parcours séparés, provenance en amont, feature map, installation
  d'abonnement, déterminisme, réutilisation incrémentale, re-scan des faits d'une version antérieure).
- Tests de cartographie existants : deux tests de `cartography-trace.test.ts` encodaient la descente de
  la provenance ; ils ont été mis à jour (commentaires justifiés). Un test Java (`@RequestBody String`)
  a révélé une tentative de relation sans objet, corrigée dans le moteur sans changer le test.
- `tests/integration/sdk-cartography.test.ts` : la route `unresolved` sur le vrai serveur.
- Typage (`tsc --noEmit`) : sans erreur. Lint : 3 conditions inutiles signalées puis corrigées (les
  trois fichiers relus par ESLint sans erreur). Format : conforme.
- Suite unitaire complète : 297 fichiers, 3 389 tests passés, 1 ignoré.
- Intégration (vrai serveur, une à la fois) : `sdk-cartography` 8/8, `sdk-dashboard-cartography` 10/10
  (Chromium ; ce test ne visite pas le nouvel onglet).
- `npm run build` et `npm run pack:check` : réussis.

## Non fait, à reprendre

1. Invalidation incrémentale par les dépendances externes (Maven, configuration).
2. Conditions par site d'appel quand une relation est fusionnée (seule la première est gardée).
3. Évaluation abstraite des conditions RxJS selon le contexte d'émission.
4. Vérification ciblée (lecteurs de preuve par type de relation).
5. Budgets FAST / BALANCED / DEEP du scan.
6. État INVALIDATED d'une relation.
7. Chemin de retour des données BFF / Java vers le composant.
8. Persistance du graphe en base de données.
9. Mesures sur une application de 100 000 à 500 000 lignes.
10. Vérification dans Chromium de l'onglet « Liens non résolus » (rendu testé en unitaire seulement).

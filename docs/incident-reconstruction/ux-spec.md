# Spécification UX : Investigation Workspace

Ce document fixe la structure, les parcours, les états, les règles responsive et d'accessibilité et le
langage visuel des écrans Incidents du Dashboard, autour de l'**Investigation Workspace**. Il s'appuie
sur l'audit (`audit.md`) et sur le contrat `src/sdk/core/incident-contracts.ts`. Les briques de
structure sont dans `src/sdk/ui/incident-ux.ts`.

Principes non négociables :

- **Vérité des relations** : une relation affiche toujours son statut (Observée, Lue dans le code,
  Déduite, Inconnue). Un parcours lu dans le code n'est jamais présenté comme une trace d'exécution ;
  aucune durée n'est affichée pour un nœud de code.
- **Vérité du diagnostic** : « confirmée » n'apparaît que pour `Diagnosis.status === 'CONFIRMED'` (ou
  une hypothèse `CONFIRMED`). PROBABLE se lit « Cause probable, à vérifier » ; INCONCLUSIVE « Diagnostic
  inconclusif ».
- **Vérité de la non-régression** : « réussi » seulement si `regression.execution.passed` est vrai.
- **Démonstration** : un jeu fictif (catalogue de livres) porte toujours le bandeau « Données de
  démonstration » ; il n'est jamais présenté comme un diagnostic réel.
- **Une seule reproduction de référence** : `incidentReproduction()` (dernier run terminé du scénario
  de l'incident), partout (progression, vue d'ensemble, graphe, rapport).

## 1. Arborescence des écrans

```
Incidents (menu « Incidents », section du panneau de navigation)
├── Liste des incidents                     route { view: 'incidents' }
│   └── Déclaration d'un incident           route { view: 'incidents', create: true }
└── Investigation Workspace                 route { view: 'incident', incidentId, tab? }
    ├── En-tête (titre, gravité, état, environnement, scénario, mise à jour, actions)
    ├── Progression en 10 étapes
    │   Description → Périmètre → Environnement → Reproduction → Preuves →
    │   Analyse du code → Traçabilité → Diagnostic → Rapport → Non-régression
    ├── Onglets
    │   ├── Vue d'ensemble          (faits, reproduction de référence, diagnostic, suite)
    │   ├── Chronologie             (événements unifiés, heures estimées signalées)
    │   ├── Traçabilité             (graphe full-stack Frontend → BFF → Backend)
    │   ├── Requêtes HTTP           (échanges, statuts, corps et en-têtes masqués)
    │   ├── Frontend                (étape → élément → composant → handler → service → requête)
    │   ├── BFF / Backend           (endpoints, services, appels, exceptions de la couche)
    │   ├── Journaux                (lignes de journaux autorisées par le périmètre)
    │   ├── Hypothèses              (preuves favorables et contraires, confiance)
    │   ├── Expériences             (vérifications, approbations, décisions du périmètre)
    │   ├── Rapport                 (JSON / Markdown)
    │   └── Non-régression          (proposition, validation, exécution réelle)
    ├── Panneau contextuel           (détail de la sélection : preuve, requête, extrait de code,
    │                                 capture, erreur, hypothèse)
    └── Écrans de configuration ouverts depuis la progression
        ├── Périmètre et extensions  (applications, scénarios, endpoints, profondeur, approbations)
        ├── Environnement            (sélecteur LOCAL / REMOTE / ARO)
        └── Reproduction             (lancement, suivi, runs et preuves)
```

Correspondance proposée étape → vue (l'intégration la fixe) : Description → Vue d'ensemble ;
Périmètre → Périmètre ; Environnement → sélecteur d'environnement ; Reproduction et Preuves →
Requêtes HTTP / Chronologie ; Analyse du code → Frontend, BFF, Backend ; Traçabilité → Traçabilité ;
Diagnostic → Hypothèses ; Rapport → Rapport ; Non-régression → Non-régression.

## 2. Parcours utilisateur

### 2.1 Parcours principal

1. **Déclarer** : liste → « Nouvel incident » → titre, gravité, observé, attendu, scénario, environnement
   du projet, cible d'exécution (LOCAL par défaut). Envoi → ouverture du Workspace, étape « Périmètre ».
2. **Délimiter** : ajouter au moins une application (dépôt, dossiers, classes) et le scénario ;
   valider le périmètre ; les extensions demandées attendent une décision (droit DECIDE).
3. **Choisir l'environnement** : trois cartes LOCAL / REMOTE / ARO ; ARO exige namespace, ServiceAccount,
   image et montage des dépôts ; « Enregistrer l'environnement » (modification par révision, 409 relu).
4. **Reproduire** : lancement Playwright ; la progression montre « Reproduction : en cours » ; la page
   relit l'incident pendant le run ; le verdict (symptôme observé, non observé, run non abouti) s'affiche.
5. **Examiner les preuves** : requêtes en échec, première erreur JavaScript, captures, chronologie.
6. **Analyser le code** puis **relier** : index de code, graphe de traçabilité, statut de chaque relation.
7. **Diagnostiquer** : hypothèses, expériences (approbation explicite des effets de bord), diagnostic
   avec son statut exact et ce qui manque pour conclure.
8. **Rapporter** : rapport JSON / Markdown disponible dès qu'un diagnostic existe.
9. **Non-régression** : proposition du scénario, validation (droit PUBLISH), exécution réelle, verdict.

La carte « Prochaine étape recommandée » de la vue d'ensemble dit à tout moment quoi faire ensuite et
mène à l'étape (bouton `ws-ux-stage`).

### 2.2 Sélection synchronisée

- Sélectionner une **requête** (liste, chronologie, graphe, vue d'ensemble) : ses nœuds du graphe, ses
  événements de la chronologie, son étape et son code relié sont mis en évidence (`ws-related`), le reste
  est atténué (`ws-dimmed`) ; le panneau contextuel montre la requête et propose l'extrait de code
  (`sourceOf`), ouvert dans l'explorateur par `ws-code`.
- Sélectionner un **nœud** : ses preuves, son symbole, son fichier ; une **hypothèse** : ses preuves, ses
  fichiers, ses expériences ; un **événement** : sa requête, son étape, sa source.
- La sélection est unique, partagée par toutes les vues (`WorkspaceContext.selection`) ; Échap la vide ;
  un second clic sur l'élément sélectionné la vide aussi.
- Les liaisons viennent des seules données (`incident-links.ts`) : rien n'est relié par supposition.

## 3. États d'interface

Chaque panneau utilise `panelState()` : chargement (`aria-busy`), vide (texte qui dit quoi faire),
erreur (`role="alert"` et « Réessayer »), accès refusé (texte, sans bouton d'action).

| Écran                | Chargement                  | Vide                                     | Erreur                                  | Accès refusé                        | Démonstration           | En cours / suivi                                                          | Annulé                                            |
| -------------------- | --------------------------- | ---------------------------------------- | --------------------------------------- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Liste des incidents  | squelette « Chargement… »   | « Aucun incident » + « Nouvel incident » | message + Réessayer                     | liste en lecture, sans création     | ligne marquée Démo      | état « Reproduction en cours » en pastille                                | pastille « Annulé »                               |
| Déclaration          | bouton occupé (`aria-busy`) | formulaire vierge, LOCAL coché           | champs `aria-invalid` + `role="alert"`  | formulaire absent                   | —                       | envoi en cours, bouton désactivé                                          | « Annuler » ferme le formulaire                   |
| Périmètre            | carte occupée               | « Aucune application »                   | validation : liste des problèmes        | lecture seule, pas d'édition        | bandeau                 | —                                                                         | édition indisponible                              |
| Environnement        | capacités « Chargement… »   | capacités inconnues : texte général      | message sous les cartes, `role="alert"` | « Lecture seule » ; cartes visibles | bandeau                 | enregistrement : bouton occupé ; reproduction : indisponible selon l’état | indisponible, motif affiché                       |
| Reproduction         | —                           | « Aucune reproduction terminée »         | erreur du run                           | pas de lancement                    | bandeau                 | spinner, relecture 1,5 s, étape « en cours »                              | run arrêté, « Reprendre »                         |
| Preuves / Requêtes   | panneau occupé              | « Aucune requête capturée »              | panneau erreur                          | panneau refusé                      | bandeau                 | liste qui grandit                                                         | figée                                             |
| Traçabilité (graphe) | panneau occupé              | « Analyse non lancée » + action          | panneau erreur                          | panneau refusé                      | bandeau + légende       | redessin sans perdre zoom ni sélection                                    | figé                                              |
| Code                 | extrait « Chargement… »     | « Fichier hors périmètre » ou vide       | refus du Scope Policy Engine (motif)    | droit de lecture absent             | bandeau                 | —                                                                         | lecture seule                                     |
| Diagnostic           | —                           | « Pas encore de diagnostic »             | erreur de l'opération                   | pas d'action                        | bandeau                 | expérience en cours : pastille, relecture                                 | actions indisponibles                             |
| Rapport              | « Chargement… »             | « Établir le diagnostic d'abord »        | message + Réessayer                     | lecture seule                       | bandeau dans le rapport | —                                                                         | rapport lisible                                   |
| Non-régression       | bouton occupé               | « Pas encore proposé »                   | erreur d'exécution                      | validation masquée sans PUBLISH     | bandeau                 | exécution en cours                                                        | indisponible                                      |
| Workspace (en-tête)  | squelette + identifiant     | —                                        | `messages()` (zone d'erreur)            | mention « Lecture seule »           | `demoBanner`            | pastille « Reproduction : en cours » + étape animée                       | « Annulé (annulé à l'état « … ») », étape Bloquée |

Une seule zone `aria-live="polite"` par page (celle des messages de l'intégration) annonce ce qui
change ; les pièces redessinées pendant le suivi n'ont pas de zone live propre (le Shadow DOM est
réécrit à chaque relecture, une zone recréée serait annoncée en boucle).

## 4. Responsive

Desktop d'abord ; points de rupture par requêtes de conteneur sur l'hôte (comme le Dashboard).

| Largeur du composant | Disposition du Workspace                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1280 px            | graphe en bande pleine largeur sous les onglets ; dessous, contenu de l'onglet et panneau contextuel collant (340 px) côte à côte |
| 960 – 1280 px        | une colonne : bande du graphe, contenu, panneau                                                                                   |
| 600 – 960 px         | une colonne : contenu, graphe, panneau ; menu du Dashboard replié derrière son bouton                                             |
| < 600 px             | une colonne ; le graphe défile dans son cadre ; la progression défile horizontalement ; cartes empilées                           |

Onglets de code et de formulaire (Frontend, BFF, Backend, Périmètre, Environnement) : la bande du graphe passe
sous le contenu, qui prend toute la largeur. Onglet Traçabilité : le graphe est le contenu (pas de bande en
double). La barre des onglets passe à la ligne au lieu de défiler ; la progression tient sur une ligne
(≥ 1040 px), deux lignes de cinq (≥ 600 px), ou défile avec une ombre de bord (< 600 px). Ce tableau remplace la
disposition en trois colonnes de la première version (graphe trop étroit, constat de la revue QA).

Règles : tout en flex/grid qui passe à la ligne ; tableaux dans `<div class="tw">` ; cibles tactiles de
44 px (40 px pour les petits boutons) ; aucun défilement horizontal de la page ; le panneau contextuel ne
masque jamais la sélection.

## 5. Accessibilité

- **Clavier** : tout élément interactif est un `<button>` (ou porte rôle, `tabindex` et clavier).
  Onglets : `role="tablist"`, tabindex itinérant, flèches / Début / Fin (`rovingTarget`). Cibles
  d'exécution : `role="radiogroup"`, `role="radio"`, `aria-checked`, mêmes touches. Graphe : nœuds
  focalisables, flèches entre voisins, Entrée sélectionne, Échap vide la sélection ; la table des
  relations reste l'alternative textuelle.
- **Focus** : visible partout (contour de 3 px mélangé à l'accent) ; restauré après chaque redessin
  (l'intégration ajoute `data-ws-field` aux attributs mémorisés par `paint()`) ; jamais piégé.
- **Annonces** : progression dans un `<nav>` avec liste ordonnée et `aria-current="step"` ; états par le
  texte (Terminée, Étape actuelle, À venir, Bloquée, En cours), jamais par la seule couleur ; pastilles
  préfixées pour les lecteurs d'écran (« Gravité : Haute ») ; erreurs en `role="alert"` ; chargement en
  `aria-busy`.
- **Formulaires** : `<label for>`, `aria-required`, `aria-invalid`, aide liée par `aria-describedby`.
- **Contraste** : jetons du thème seulement, vérifiés en clair et en sombre ; statuts de relation portés
  aussi par le style de trait (plein, plein, tirets, pointillés) et par le libellé ; texte sur l'accent
  rempli en `--qa-color-surface`.
- **Mouvement** : animations neutralisées sous `prefers-reduced-motion`.

## 6. Langage visuel

- **Coquille** : panneau de navigation sombre (`--qa-color-panel`, indigo nuit) déjà en place ; contenu
  sur fond clair (`--qa-color-background`) en cartes blanches (`.card`, rayon `--qa-radius`).
- **Accent** : `--qa-color-primary` (bleu indigo) pour la sélection, l'étape actuelle, l'onglet actif ;
  en-tête du Workspace avec liseré gauche de l'accent.
- **Typographie** : IBM Plex Sans, IBM Plex Mono pour code, chemins, requêtes.
- **Pastilles** : `.pill` ok / ko / warn / live / mu (états, gravité, diagnostic, verdicts).
- **Relations** (`incident-parts.ts`) : Observée = accent, trait plein épais ; Lue dans le code = succès,
  trait plein ; Déduite = avertissement, tirets ; Inconnue = danger, pointillés ; légende
  `relationLegend` sur chaque vue qui en montre.
- **Sélection** : `ws-selected` (contour de l'accent), `ws-related` (fond teinté), `ws-dimmed` (opacité).
- **Diagnostic** : encart plein (confirmé), tirets (probable), pointillés (inconclusif).
- **Thème sombre** : seuls les jetons changent ; aucune couleur littérale hors `color-mix` de jetons.

## 7. Composants communs et propriétaires

| Composant                                                                                                                                        | Fichier                                                                   | Propriétaire               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------- |
| Contrat (types, `incidentReproduction`)                                                                                                          | `src/sdk/core/incident-contracts.ts`                                      | lead                       |
| Index de sélection (`workspaceLinks`, `relatedKeys`, `sourceOf`, `fileId`, `edgeId`, `stepId`)                                                   | `src/sdk/ui/incident-links.ts`                                            | lead                       |
| `WorkspaceContext`, `selectable`, `selectionClass`, `relationBadge`, `relationLegend`, `sourceLink`, `evidenceChips`, `panelState`, `demoBanner` | `src/sdk/ui/incident-parts.ts`                                            | lead                       |
| Progression, en-tête, onglets, vue d'ensemble, sélecteur d'environnement, coquille responsive                                                    | `src/sdk/ui/incident-ux.ts`                                               | incident-ux-architect      |
| Onglet Frontend (traçabilité frontend) et son moteur                                                                                             | `src/sdk/ui/incident-frontend-trace.ts`, `src/incident/frontend-trace.ts` | frontend-trace-designer    |
| Graphe full-stack (Traçabilité, BFF, Backend) et enrichissement du corrélateur                                                                   | `src/sdk/ui/incident-graph.ts`, `src/incident/correlator.ts`              | fullstack-trace-designer   |
| Chronologie, Requêtes HTTP, Journaux ; moteur de chronologie, en-têtes retenus par liste blanche                                                 | `src/sdk/ui/incident-timeline.ts`, `src/incident/timeline.ts`             | evidence-timeline-designer |
| Explorateur de code (panneau contextuel, extraits)                                                                                               | `src/sdk/ui/incident-code.ts`                                             | code-explorer-designer     |
| Hypothèses, Expériences, Diagnostic, Rapport, Non-régression                                                                                     | `src/sdk/ui/incident-diagnosis.ts`                                        | diagnosis-designer         |
| Liste, déclaration, périmètre et extensions (existants)                                                                                          | `src/sdk/ui/dashboard-incidents.ts`                                       | intégration (vague 3)      |
| Coquille, contrôleur, chargements, sélection, jeu de démonstration, navigation                                                                   | `dashboard.ts`, `dashboard-view.ts`, `dashboard-incidents-controller.ts`  | intégration (vague 3)      |

## 8. Contrat d'intégration de `incident-ux.ts`

| Élément                                   | `data-action`        | Données                           | Traitement                                                                                                                                                                        |
| ----------------------------------------- | -------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Étape de la progression, « Aller à… »     | `ws-ux-stage`        | `data-stage`                      | intégration : étape → onglet ou écran (route)                                                                                                                                     |
| Onglet                                    | `ws-ux-tab`          | `data-tab`                        | intégration : route `tab` ; flèches par `rovingTarget`                                                                                                                            |
| Carte de cible                            | `ws-ux-target`       | `data-target`                     | `reduceUx`                                                                                                                                                                        |
| Champ OpenShift / ARO (événement `input`) | `ws-ux-field`        | `{ field: data-ws-field, value }` | `reduceUx`                                                                                                                                                                        |
| Revenir à l'environnement enregistré      | `ws-ux-target-reset` | —                                 | `reduceUx`                                                                                                                                                                        |
| Enregistrer l'environnement               | `ws-ux-target-save`  | —                                 | `reduceUx` (en cours) puis `executionOf()` : champs manquants → `ws-ux-invalid` ; sinon `update(revision, { execution })` → `ws-ux-saved` ou `ws-ux-error` ; relire les capacités |

Feuilles de style à ajouter après `DASHBOARD_CSS` : `INCIDENT_PARTS_CSS`, puis `INCIDENT_UX_CSS`.

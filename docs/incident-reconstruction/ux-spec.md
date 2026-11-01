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
└── Investigation Workspace                 route { view: 'incident', incidentId, tab? }   (tab = clé de vue)
    ├── En-tête compact (une ligne : retour, titre tronqué, gravité, état, diagnostic, environnement,
    │   actions) + divulgation « Détails » (scénario, description, observé / attendu, mise à jour,
    │   reproduction de référence)
    ├── Progression repliable : ligne fine (étape actuelle, « n/10 », barre) ↔ les 10 étapes
    │   Description → Périmètre → Environnement → Reproduction → Preuves →
    │   Analyse du code → Traçabilité → Diagnostic → Rapport → Non-régression
    ├── Onglets principaux (une ligne) et sous-onglets
    │   ├── Vue d'ensemble   : Résumé · Périmètre · Environnement            (document)
    │   ├── Reproduction     : Exécution · Preuves · Chronologie · Journaux   (document)
    │   ├── Traçabilité      : Full Stack · Frontend · BFF · Backend · HTTP   (panneaux)
    │   ├── Code             : —                                              (panneaux, zone haute réduite)
    │   ├── Diagnostic       : Diagnostic · Hypothèses · Expériences          (document)
    │   └── Rapport          : Rapport · Non-régression                       (document)
    └── Corps : panneaux qui défilent chacun en eux-mêmes (voir § 9)
```

Les quinze clés historiques restent des **clés de vue** (route `tab`, progression, liens) ; chacune
désigne un onglet et un sous-onglet (`VIEW_ROUTES` dans `incident-workspace.ts`) : overview → Vue
d'ensemble/Résumé, scope → Vue d'ensemble/Périmètre, environment → Vue d'ensemble/Environnement,
run → Reproduction/Exécution, evidence → Reproduction/Preuves (clés ajoutées pour la maquette),
timeline → Reproduction/Chronologie, logs → Reproduction/Journaux, traceability → Traçabilité/Full Stack,
requests → Traçabilité/HTTP, frontend, bff, backend → Traçabilité/couche, hypotheses, experiments,
diagnosis → Diagnostic/…, report, regression → Rapport/…, plus `code` → Code. Un clic sur un onglet
principal rouvre son dernier sous-onglet.

Correspondance étape → vue (`STAGE_TABS`) : Description → Vue d'ensemble ; Périmètre → Périmètre ;
Environnement → Environnement ; Reproduction → Exécution ; Preuves → Preuves ; Analyse du code → Code ;
Traçabilité → Full Stack ; Diagnostic → Diagnostic ; Rapport → Rapport ; Non-régression → Non-régression.

## 2. Parcours utilisateur

### 2.1 Parcours principal

1. **Déclarer** : liste → « Nouvel incident » → titre, gravité, observé, attendu, scénario, environnement
   du projet, cible d'exécution (LOCAL par défaut). Envoi → ouverture du Workspace, étape « Périmètre ».
2. **Délimiter** : indiquer le chemin du projet (ou réutiliser un dépôt connu de l'environnement) et « Analyser
   automatiquement » : les applications détectées (cadres, couche, modules, relations, preuves) sont cochées
   quand elles sont proposées pour l'incident ; corriger une couche si la découverte n'a pu que la déduire ;
   « Ajouter au périmètre » ; la saisie manuelle (identifiant, couche, racine, dossiers, classes) reste dans
   « Paramètres avancés », repliée ; choisir les dossiers et le scénario ; valider le périmètre ; les extensions
   demandées attendent une décision (droit DECIDE). Une fois l'investigation commencée, le même bloc demande des
   extensions du périmètre au lieu de le modifier.
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

| Écran                | Chargement                            | Vide                                           | Erreur                                                                         | Accès refusé                              | Démonstration           | En cours / suivi                                                          | Annulé                                            |
| -------------------- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Liste des incidents  | squelette « Chargement… »             | « Aucun incident » + « Nouvel incident »       | message + Réessayer                                                            | liste en lecture, sans création           | ligne marquée Démo      | état « Reproduction en cours » en pastille                                | pastille « Annulé »                               |
| Déclaration          | bouton occupé (`aria-busy`)           | formulaire vierge, LOCAL coché                 | champs `aria-invalid` + `role="alert"`                                         | formulaire absent                         | —                       | envoi en cours, bouton désactivé                                          | « Annuler » ferme le formulaire                   |
| Périmètre            | carte occupée ; « Analyse en cours… » | « Aucune application » ; « Aucun dépôt connu » | validation : liste des problèmes ; découverte : problème expliqué + correction | lecture seule, pas d'édition ni d'analyse | bandeau                 | —                                                                         | édition indisponible                              |
| Environnement        | capacités « Chargement… »             | capacités inconnues : texte général            | message sous les cartes, `role="alert"`                                        | « Lecture seule » ; cartes visibles       | bandeau                 | enregistrement : bouton occupé ; reproduction : indisponible selon l’état | indisponible, motif affiché                       |
| Reproduction         | —                                     | « Aucune reproduction terminée »               | erreur du run                                                                  | pas de lancement                          | bandeau                 | spinner, relecture 1,5 s, étape « en cours »                              | run arrêté, « Reprendre »                         |
| Preuves / Requêtes   | panneau occupé                        | « Aucune requête capturée »                    | panneau erreur                                                                 | panneau refusé                            | bandeau                 | liste qui grandit                                                         | figée                                             |
| Traçabilité (graphe) | panneau occupé                        | « Analyse non lancée » + action                | panneau erreur                                                                 | panneau refusé                            | bandeau + légende       | redessin sans perdre zoom ni sélection                                    | figé                                              |
| Code                 | extrait « Chargement… »               | « Fichier hors périmètre » ou vide             | refus du Scope Policy Engine (motif)                                           | droit de lecture absent                   | bandeau                 | —                                                                         | lecture seule                                     |
| Diagnostic           | —                                     | « Pas encore de diagnostic »                   | erreur de l'opération                                                          | pas d'action                              | bandeau                 | expérience en cours : pastille, relecture                                 | actions indisponibles                             |
| Rapport              | « Chargement… »                       | « Établir le diagnostic d'abord »              | message + Réessayer                                                            | lecture seule                             | bandeau dans le rapport | —                                                                         | rapport lisible                                   |
| Non-régression       | bouton occupé                         | « Pas encore proposé »                         | erreur d'exécution                                                             | validation masquée sans PUBLISH           | bandeau                 | exécution en cours                                                        | indisponible                                      |
| Workspace (en-tête)  | squelette + identifiant               | —                                              | `messages()` (zone d'erreur)                                                   | mention « Lecture seule »                 | `demoBanner`            | pastille « Reproduction : en cours » + étape animée                       | « Annulé (annulé à l'état « … ») », étape Bloquée |

Une seule zone `aria-live="polite"` par page annonce ce qui change : `p.inc-live` (`role="status"`,
`aria-atomic`), un nœud **permanent** du Shadow DOM, créé une fois à côté de la partie redessinée
(`.qa-view`) et jamais recréé par `paint()`. Le message en clair (`p.inc-msg`, dans les remarques sous
l'en-tête) est redessiné ; `IncidentsController.afterPaint` en recopie le texte dans la zone live
seulement quand il change (pas au premier dessin, pas à un redessin au même texte : suivi, sélection,
disposition), puis l'efface de la zone live après 8 s (le message en clair reste). Mesuré : 7 actions de
disposition et d'onglet après « Vérification planifiée. » → 0 réinsertion (14 avant). Les pièces
redessinées n'ont pas de zone live propre. Un dessin demandé pendant un dessin (le « change » d'un champ
qui perd le focus pendant la réécriture) est fait juste après, jamais imbriqué.

Démonstration : le bandeau « Données de démonstration » est dit **une fois**, dans l'en-tête, sur une
ligne (le détail en infobulle) ; le contexte des vues porte `demoInShell: true`, si bien que graphe,
preuves, périmètre, diagnostic ne le répètent pas. La note `#ws-demo-why` (motif des actions
indisponibles, référencée par `aria-describedby` de chaque bouton désactivé) est dans ce bandeau, lue par
les lecteurs d'écran.

## 4. Responsive

L'espace d'investigation tient dans la fenêtre, comme l'éditeur : la coquille du Dashboard prend
`max(560px, 100dvh − 32px)` (les 16 px de marge de la page, de chaque côté), le contenu se resserre
(10 px × 8 px), le menu défile en lui-même et `.ws-root` remplit le reste (`flex:1; min-height:0;
overflow:hidden auto`). Le document ne défile plus : mesuré dans Chromium, `scrollHeight = innerHeight` à
1440 × 900, 1366 × 768, 1280 × 800, 1024 × 768 et 820 × 1180 sur chaque onglet.

**Plancher du corps** : la zone des panneaux garde au moins 380 px de haut (`WORKSPACE_BODY_MIN_PX` : zone
haute 200 + séparateur + zone basse 160, avec leurs bords). Quand la progression complète, les « Détails »
de l'en-tête ou une fenêtre basse ne lui laissent plus cette place, `.ws-root` défile verticalement — et
seulement alors : aucun panneau n'est jamais coupé (mesuré : progression + Détails ouverts à 1440 × 900,
1366 × 768, 1280 × 800 et 1024 × 768, réel et démonstration : corps 380 px, 0 élément inatteignable).
Choix d'un plancher plutôt que d'une surcouche : la progression et les détails restent dans le flux (pas de
fenêtre flottante à fermer, pas de piège au focus) et l'état par défaut ne défile jamais. La préférence
`stepper` reste mémorisée.

En-tête : une ligne dès 980 px d'espace (pastilles sur la ligne du titre, boutons de 32 px ; sous 1 100 px,
« Incidents » et « Détails » en icônes avec leur nom accessible) : 42 px à 1440, 1366 et 1280 (66 et 96
avant), 78 px à 1024 (les actions passent à la ligne). « Mode compact » resserre en-tête, progression,
onglets, sous-onglets et barres de panneau : 50 px de moins au-dessus des panneaux, 72 px de plus pour le
graphe et l'éditeur (29 px avant).

| Largeur (conteneur des panneaux) | Disposition                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 720 px                         | deux zones (Traçabilité, Code) ou contenu \| détails (document), séparateurs redimensionnables ; minimums : graphe 320 px, détails 260, fichiers 180, code 300, preuves 200, contenu 360 ; zone haute ≥ 200 px de haut, basse ≥ 160 ; arborescence à 20 % (≈ 225 px à 1440)                                                                                                   |
| 720 – 1 100 px (tablette)        | même disposition avec les minimums ci-dessus (ils tiennent dans 720 px) ; de 720 à 900 px d'espace (1024 × 768, 820 × 1180), l'arborescence s'ouvre réduite en rail (titre court « Fichiers »), sans préférence enregistrée tant que la personne n'y touche pas ; de 900 à 1 100 px elle reste dépliée (≥ 190 px, noms lisibles) ; rail et preuves se rouvrent par leur barre |
| < 720 px                         | un seul panneau à la fois, choisi par un sélecteur (Graphe / Détails / Fichiers / Code / Preuves, ou Contenu / Détails) ; une sélection propose « Voir le détail » sans changer de panneau ; pas de séparateur                                                                                                                                                                |

Sous 560 px de haut ou 600 px de large (fenêtre), la page retrouve sa hauteur naturelle : les panneaux
d'un document s'empilent à leur hauteur, la disposition en panneaux garde une hauteur fixe
(`max(480px, 100dvh − 48px)`) dans une page qui défile ; rien n'est jamais inaccessible.

Règles : tout en flex/grid ; chaque panneau `min-height:0; min-width:0; overflow:auto` ; tableaux dans
`<div class="tw">` ; aucun défilement horizontal de la page ; la barre des onglets tient sur une ligne
(défilement horizontal propre sous 600 px).

## 5. Accessibilité

- **Clavier** : tout élément interactif est un `<button>` (ou porte rôle, `tabindex` et clavier).
  Onglets et sous-onglets : `role="tablist"`, tabindex itinérant, flèches / Début / Fin (`rovingTarget`),
  identifiants `ws-ux-tab-<onglet>` et `ws-ux-sub-<sous-onglet>`, panneau `ws-ux-panel` relié au
  sous-onglet choisi. Séparateurs : `role="separator"`, focalisables, ← → / ↑ ↓ (2 %), Maj (10 %),
  Début / Fin (minimum / maximum), Entrée (réduire ou déplier le premier panneau), double clic (taille
  par défaut). Panneau agrandi : Échap le rétablit (avant de vider la sélection). Éditeur : Ctrl/Cmd + G
  ouvre « Aller à la ligne ». Cibles
  d'exécution : `role="radiogroup"`, `role="radio"`, `aria-checked`, mêmes touches. Graphe : nœuds
  focalisables, flèches entre voisins, Entrée sélectionne, Échap vide la sélection ; la table des
  relations reste l'alternative textuelle.
- **Focus** : visible partout ; dans l'espace, contour plein de 2 px à l'accent (`.ws-root :where(:focus-visible)`,
  5,8:1 à 6,5:1 mesurés dans les deux thèmes) ; restauré après chaque redessin (l'intégration ajoute
  `data-ws-field` aux attributs mémorisés par `paint()`) ; jamais piégé ni perdu : un bouton retrouvé dans
  un corps masqué (panneau réduit) cède le focus au bouton « Déplier » de ce panneau (« Replier
  l'arborescence » → « Déplier »), l'encart d'approbation d'une expérience à effets de bord s'ouvre avec le
  focus sur « Annuler », Échap ferme d'abord un menu ouvert (« Couches » du graphe) ; défilement de
  chaque panneau gardé par vue (Périmètre ↔ Résumé). Séparateurs : `aria-valuemin`, `aria-valuemax` et
  `aria-valuenow` disent la position rendue (bornée par la place réelle), la première flèche bouge.
- **Annonces** : progression dans un `<nav>` avec liste ordonnée et `aria-current="step"` ; états par le
  texte (Terminée, Étape actuelle, À venir, Bloquée, En cours), jamais par la seule couleur ; pastilles
  préfixées pour les lecteurs d'écran (« Gravité : Haute ») ; erreurs en `role="alert"` ; chargement en
  `aria-busy`.
- **Formulaires** : `<label for>`, `aria-required`, `aria-invalid`, aide liée par `aria-describedby`.
- **Contraste** : jetons du thème seulement, vérifiés en clair et en sombre ; poignée de séparateur au
  repos en `--qa-color-muted` (6,7:1 / 8,3:1), bord des panneaux et des commandes `--ws-edge` (mélange
  de `muted` et `border-strong` : 3,3:1 / 4,5:1 au moins) ; zone de saisie des séparateurs de 12 px pour
  une piste de 6 px ; statuts de relation portés
  aussi par le style de trait (plein, plein, tirets, pointillés) et par le libellé ; texte sur l'accent
  rempli en `--qa-color-surface`.
- **Mouvement** : animations neutralisées sous `prefers-reduced-motion`.

## 6. Langage visuel

- **Coquille** : panneau de navigation vert foncé (`--qa-color-panel`, `#004D2B`) avec le motif de facettes
  au bas du menu ; contenu sur fond clair (`--qa-color-background`) en cartes blanches (`.card`, rayon
  `--qa-radius`).
- **Accent** : `--qa-color-primary` (vert `#006B3F`) pour la sélection, l'étape actuelle, l'onglet actif ;
  en-tête du Workspace avec liseré gauche de l'accent.
- **Capture de référence** : `captures/scope-1440-full.png`, l'étape Périmètre complète à 1440 px (menu,
  en-tête, étapes, vues, bandeau, « Applications et dépôts » avec un résultat d'analyse réel, « Définition
  du périmètre », extensions), prise par Chromium sur le serveur SDK réel.
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

| Élément                                   | `data-action`                                                                               | Données                                 | Traitement                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Étape de la progression, « Aller à… »     | `ws-ux-stage`                                                                               | `data-stage`                            | intégration : étape → onglet ou écran (route)                                                                                                                                     |
| Onglet                                    | `ws-ux-tab`                                                                                 | `data-tab`                              | intégration : route `tab` ; flèches par `rovingTarget`                                                                                                                            |
| Sous-onglet                               | `ws-ux-sub`                                                                                 | `data-sub`                              | intégration : vue (onglet, sous-onglet) ; flèches par `rovingTarget`                                                                                                              |
| « Détails » de l'en-tête                  | `ws-ux-details`                                                                             | —                                       | intégration : divulgation (`aria-expanded`)                                                                                                                                       |
| Progression repliée / dépliée             | `ws-ux-stepper`                                                                             | —                                       | intégration : préférence `stepper`                                                                                                                                                |
| Mode compact                              | `ws-ux-compact`                                                                             | —                                       | intégration : préférence `compact`                                                                                                                                                |
| Panneaux et séparateurs                   | `ws-pane`, `ws-pane-focus`, `ws-split-reset` (+ clavier et pointeur sur `data-ws-splitter`) | `data-pane`, `data-op`, `data-splitter` | `reduceSplit` (`incident-split.ts`)                                                                                                                                               |
| Carte de cible                            | `ws-ux-target`                                                                              | `data-target`                           | `reduceUx`                                                                                                                                                                        |
| Champ OpenShift / ARO (événement `input`) | `ws-ux-field`                                                                               | `{ field: data-ws-field, value }`       | `reduceUx`                                                                                                                                                                        |
| Revenir à l'environnement enregistré      | `ws-ux-target-reset`                                                                        | —                                       | `reduceUx`                                                                                                                                                                        |
| Enregistrer l'environnement               | `ws-ux-target-save`                                                                         | —                                       | `reduceUx` (en cours) puis `executionOf()` : champs manquants → `ws-ux-invalid` ; sinon `update(revision, { execution })` → `ws-ux-saved` ou `ws-ux-error` ; relire les capacités |

Feuilles de style à ajouter après `DASHBOARD_CSS` : `INCIDENT_PARTS_CSS`, puis `INCIDENT_UX_CSS`.

## 9. Disposition en panneaux (v2) et préférences

Module `src/sdk/ui/incident-split.ts` (pur) : `SplitUi { sizes, panes, maximized?, mobilePane?, codeTop }`,
`reduceSplit(ui, action, dataset)`, `renderPane`, `renderSplitter`, `renderSplitLayout`, `renderHiddenBar`,
`splitTemplates`, `readPrefs(storage)` / `writePrefs(storage, prefs)`.

- Panneaux : `primary`, `details`, `tree`, `editor`, `evidence` (Traçabilité, Code) ; `content`, `details`
  (document). Séparateurs : `top-bottom`, `primary-details`, `tree-editor`, `editor-evidence`,
  `content-details`. Une taille est la position du séparateur (fraction 0..1 de sa zone) ; la grille est
  `minmax(<minimum> px, <part> fr)` (parts entières : une somme de parts inférieure à 1 laisserait de la
  place vide).
- Barre de chaque panneau : titre (tronqué, infobulle), puis « Agrandir / Rétablir » (`aria-pressed`),
  « Réduire / Déplier » (`aria-expanded`), « Masquer » ; `data-action="ws-pane" data-pane data-op`.
  Les panneaux masqués sont rappelés par la barre « Panneaux masqués » (à droite des onglets), avec
  « Mode compact » et « Réinitialiser la disposition ».
- Traçabilité : primary = graphe compact (Full Stack), traçabilité frontend, graphe restreint au BFF ou
  au Backend, requêtes HTTP ; details = panneau contextuel (volets `<details>` pour les données, la
  requête reliée, le code relié, toutes les relations) ; zone basse = l'explorateur de code
  (`renderCodeWorkspace`). Onglet Code : même disposition, zone haute réduite à ses barres par défaut.
- Contrôleur : glisser au pointeur (capture, grille posée en direct, état au relâcher), clavier, Échap,
  cadre du graphe observé (`ws-graph-viewport` à 8 px près, une mesure par image), sélection → endroit
  du code montré dans l'éditeur (`revealInCode`), défilement de chaque panneau et focus gardés au redessin.
- Préférences : clé `qa-crawler:incident-workspace:v2`, JSON `{ sizes, panes, maximized?, tab, subs,
graphZoom?, graphLayout?, compact, stepper, treeCollapsed, codeTop }` (`codeTop` : zone haute ouverte sur l'onglet
  Code). Chaque champ est validé à la lecture ; écriture 300 ms après le dernier changement ; stockage
  absent ou refusé : la page fonctionne avec les valeurs par défaut. Communes à toutes les investigations.

## 10. Les douze écrans de la maquette dans l'espace

La navigation globale du Dashboard ne change pas ; l'espace garde sa disposition en panneaux (aucun
défilement du document à 1440×900, 1280×800 et 1024×768 sur les vues de l'espace). Les écrans de la
maquette (Périmètre, Environnement, Exécution, Preuves, Diagnostic, Rapport, Non-régression :
`FULL_WIDTH_VIEWS`) occupent toute la largeur : le panneau des détails n'y apparaît qu'avec une sélection.

| Écran                           | Vue (route `tab`)                     | Module (rendu pur)                                         |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| 1. Liste des incidents          | `{ view: 'incidents' }`               | `dashboard-incidents.ts`                                   |
| 2. Création d'un incident       | `{ view: 'incidents', create: true }` | `dashboard-incidents.ts`                                   |
| 3. Définition du périmètre      | `scope` (Vue d'ensemble › Périmètre)  | `incident-scope.ts` (`renderScopeEditor`)                  |
| 4. Sélection de l'environnement | `environment`                         | `incident-ux.ts` (`renderEnvironmentSelector`)             |
| 5. Reproduction (Exécution)     | `run` (Reproduction › Exécution)      | `incident-reproduction.ts` (`renderReproductionRun`)       |
| 6. Preuves collectées           | `evidence` (Reproduction › Preuves)   | `incident-reproduction.ts` (`renderEvidence`)              |
| 7. Traçabilité Full Stack       | `traceability`                        | `incident-graph.ts` (« Disposition » : colonnes, couloirs) |
| 8. Explorateur de code          | `code`                                | `incident-code.ts` (couches, « Détails de la ligne »)      |
| 9. Diagnostic et hypothèses     | `diagnosis`                           | `incident-diagnosis.ts` (`renderDiagnosisBoard`)           |
| 10. Rapport d'investigation     | `report`                              | `incident-diagnosis.ts` (`renderReportExport`)             |
| 11–12. Test de non-régression   | `regression`                          | `incident-diagnosis.ts` (`renderRegressionTest`)           |

Le Résumé porte aussi la carte « Pièces jointes (n) » (`incident-attachments.ts`) : l'aperçu (image `data:`
ou texte masqué par le serveur) s'ouvre dans le panneau des détails.

Actions traitées par le contrôleur (`incident-workspace-controller.ts`) :

| `data-action`                                                                                               | Traitement                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws-ux-check`                                                                                               | `connectivityTargets(incident, environnement du projet)` ; pour chaque URL `environments.check(projet, …, { reach: true })` ; chaque résultat dès son arrivée |
| `ws-repro-start`                                                                                            | `incidents.reproduce` (comme l'en-tête) ; le suivi relit l'incident toutes les 1,5 s                                                                          |
| `ws-repro-stop` / `-no` / `-yes`                                                                            | confirmation dans la page (Échap la referme) ; `-yes` : `incidents.cancel`                                                                                    |
| `ws-repro-tab`, `ws-repro-ev-tab`, `ws-repro-req-tab`                                                       | `reduceReproduction` ; flèches / Début / Fin (`ws-repro-key`) puis focus `reproductionTabFocus`                                                               |
| `ws-repro-pick`, `ws-repro-ev-errors` (`change`)                                                            | `reduceReproduction`                                                                                                                                          |
| `ws-repro-ev-show`                                                                                          | sélectionne la requête ou la preuve, ouvre Reproduction › Preuves                                                                                             |
| `ws-graph-layout` (`change`)                                                                                | `reduceGraph` ; préférence `graphLayout` ; le glisser utilise `layoutGraph(…, layout)`                                                                        |
| `ws-code-layer`                                                                                             | `reduceCode`                                                                                                                                                  |
| `ws-dx-check`, `ws-dx-section` (`change`), `ws-dx-why`, `ws-dx-sections`, `ws-dx-reg-full`, `ws-dx-reg-tab` | `reduceDiagnosis` (onglets du test : flèches)                                                                                                                 |
| `ws-dx-run-selected`                                                                                        | les vérifications cochées (revérifiées par `selectedRunnable`), lancées une à une (`runExperiment`) ; erreur sous la liste                                    |
| `ws-dx-export`                                                                                              | `incidents.report(p, i, { format, sections })` → téléchargement (JSON, Markdown, HTML, PDF décodé) ; 501 → PDF indisponible pour la session, avec la raison   |
| `ws-dx-reg-spec`                                                                                            | `incidents.regressionSpec` (aussi à l'ouverture de l'onglet « Playwright ») ; 400 → indisponible avec le message du serveur ; relu après une proposition      |
| `ws-att-open` / `ws-att-close` / `ws-att-retry`                                                             | aperçu dans le panneau des détails ; contenu lu par `incidents.attachment`                                                                                    |
| `ws-att-remove` / `-no` / `-yes`                                                                            | confirmation dans la page (« Garder » d'abord) ; `-yes` : `incidents.removeAttachment`                                                                        |
| `ws-att-add` (`change` du sélecteur de fichiers)                                                            | même tri que le formulaire (type, taille, nombre), base64, `incidents.addAttachment` un à un ; fichiers écartés dits avec leur raison                         |

Suivi en direct : pendant une reproduction, l'incident relu est redessiné quand sa révision OU son
empreinte de suivi (`liveStamp` : étapes commencées, dernier signal du moteur) change ; le compteur
`[data-ws-ticking="true"]` est réécrit chaque seconde depuis `data-ws-elapsed-from`, sans redessin, et
s'arrête quand il n'est plus affiché. La ligne de la progression garde l'étape actuelle visible.

Démonstration : application « Catalogue », type Fonctionnel, deux pièces jointes au contenu généré
(dit « Données de démonstration »), un test Playwright produit pour la démonstration (marqué en tête du
code), le rapport composé des données de démonstration ; toutes les actions qui modifient l'incident ou
interrogent le serveur sont désactivées avec leur raison (`DEMO_DISABLED_ACTIONS`).

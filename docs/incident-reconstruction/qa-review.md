# Revue QA : Investigation Workspace (vague 4)

Revue et tests de l'espace d'investigation intégré au Dashboard (`src/sdk/ui/incident-*.ts`,
`src/sdk/ui/dashboard*.ts`), sur l'application réelle : serveur SDK en accès nominatif (un
administrateur, un lecteur), incident connu de `tests/fixtures/incident-app` réellement reproduit
(Playwright), analysé, vérifié (comparaison avec le scénario qui réussit), diagnostiqué (PROBABLE),
non-régression proposée et exécutée (en échec) ; un incident sans reproduction ; un incident annulé ; la
démonstration. Chromium, thèmes clair et sombre (`?theme=dark`), 1440, 1100, 800 et 390 px, 15 onglets.
Aucun code produit modifié.

## Verdict

**Utilisable, à corriger avant diffusion.** Aucun défaut bloquant. Les parcours, la sélection
synchronisée, la démonstration, les droits et la vérité des statuts sont corrects. Six défauts majeurs :
la page défile horizontalement à toutes les largeurs, des preuves du graphe mènent à « n'existe plus »,
plusieurs textes de statut sont sous le contraste AA, la table des relations est illisible, le code est
serré entre 960 et 1280 px et le graphe est illisible à « 100 % ». Le test Chromium de revue en suit
quatre (ils échouent tant que le défaut est là).

## Défauts

### Majeurs

**M1. Défilement horizontal de la page, sur tous les onglets et à toutes les largeurs.**
`src/sdk/ui/incident-ux.ts:1144` (`.ws-ux-tabs{overflow-x:auto}` sans `position`), avec le `.sr`
absolu des compteurs d'onglet (`incident-ux.ts:910`).

- Reproduire : ouvrir un incident et mesurer `document.documentElement.scrollWidth`. On obtient 1607 px
  pour une fenêtre de 1440, et 1331 px pour 390. Les autres écrans du Dashboard (accueil, liste des
  incidents) ne défilent pas.
- Cause, prouvée : les `span.sr` (`position:absolute`) des compteurs « 34 élément(s) » sont placés par
  rapport à un ancêtre situé hors de la barre d'onglets qui défile. Ils échappent donc à son rognage.
  Avec `.ws-ux-tabs,.ws-ux-stepper ol{position:relative}` injecté, la largeur retombe à 1440/1440 et à
  390/390.
- Correction : ajouter `position:relative` à `.ws-ux-tabs` et à `.ws-ux-stepper ol`.
- Test : `no horizontal page scroll, at 390 px and at 1440 px, on every tab` (échoue : 1198 > 390).

**M2. Des puces de preuve du graphe sélectionnent un élément inexistant.**
`src/sdk/ui/incident-parts.ts:167` (`evidenceChips`), appelée par `incident-graph.ts:949` (détail) et
`incident-graph.ts:1070` (table des relations).

- Reproduire : ouvrir l'onglet Traçabilité, table « Toutes les relations », colonne Preuves, puis cliquer
  une puce (par exemple `CatalogBookService.register` ou `rep_1`). Le panneau affiche « Cet élément
  n'existe plus dans l'investigation (relue entre-temps). »
- Preuve : les `edge.evidence` du vrai graphe contiennent 24 identifiants de symbole, 6 de requête,
  4 de preuve et 1 de reproduction. Seuls les identifiants de requête et de preuve sont résolus. Tout le
  reste devient `kind="evidence"`. Sur 139 sélectionnables parcourus, les 13 sélections mortes viennent
  toutes de là.
- Correction : résoudre la nature d'une référence avec l'index de `ctx.links` ou les données :
  - requête → `request` ;
  - `Evidence.id` → `evidence` ;
  - `CodeSymbol.id` → `symbol` ;
  - reproduction → puce non interactive, ou `step` si l'étape est connue ;
  - inconnue → `<span>` non interactif.
- Test : `every evidence chip of the traceability tab selects something that exists` (échoue sur
  13 références).

**M3. Contraste insuffisant des textes de statut, incohérent avec les pastilles du Dashboard.**
Le Dashboard compose ses `.pill` avec `color-mix(<statut> 62–75%, --qa-color-text)`
(`dashboard-styles.ts:153-155`). Les modules du Workspace prennent le jeton brut. Mesures faites avec
`getComputedStyle`, fond composé, thème clair :

| Élément                                                                              | Fichier                              | Contraste mesuré |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ---------------- |
| `.ws-rel-statically_resolved` « Lue dans le code »                                   | `incident-parts.ts:204`              | 2,54:1           |
| `.ws-rel-inferred` « Déduite »                                                       | `incident-parts.ts:205`              | 2,83:1           |
| `.ws-rel-unknown`                                                                    | `incident-parts.ts:206`              | 3,26:1           |
| `.ws-timeline-status` « OK » et « Erreur »                                           | `incident-timeline.ts:1072-1074`     | 3,0 et 3,62:1    |
| `.ws-timeline-est` « ≈ »                                                             | `incident-timeline.ts:1068`          | 3,46:1           |
| `.ws-frontend-trace-caveat`                                                          | `incident-frontend-trace.ts:642-643` | 3,46 et 3,91:1   |
| numéros de ligne `.ws-code-num` (`--qa-color-faint`)                                 | `incident-code.ts:1967`              | 2,59:1           |
| `.ws-code-hit` « concerné » et coloration syntaxique (`ws-code-s`, `-y`, `-n`, `-m`) | `incident-code.ts`                   | 2,5 à 4,4:1      |

- Correction : reprendre la formule des `.pill`, par exemple
  `color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))`. Pour les numéros de
  ligne, prendre `--qa-color-muted`.
- Test : `relation badges and timeline statuses reach WCAG AA (4.5:1) in the light theme` (échoue).

**M4. Table des relations illisible : colonnes « De » et « Vers » réduites à 33 et 49 px.**
`src/sdk/ui/incident-graph.ts:1151` (`.ws-graph-nodebtn{overflow-wrap:anywhere}`).

- Reproduire : ouvrir l'onglet Traçabilité à 1440 px. Les libellés des nœuds se coupent lettre par
  lettre et chaque ligne prend environ 200 px de haut. La colonne « Raison » prend 375 px et la table
  défile (842/638). Capture : `qa/shots/reltable-1440.png`.
- Cause : `overflow-wrap:anywhere` réduit à une lettre la largeur minimale du contenu, que l'algorithme
  de la table utilise pour répartir les colonnes.
- Correction : `overflow-wrap:break-word` sur `.ws-graph-nodebtn`, plus
  `min-width:12ch;max-width:28ch` sur les deux premières colonnes. Réduire aussi `.ws-graph-reason`
  (`max-width:46ch`, `incident-graph.ts:1156`).
- Test : `the relations table keeps its « De » and « Vers » columns readable at 1440 px` (échoue :
  33 < 96).

**M5. Onglets de code (Frontend, BFF, Backend) serrés entre 960 et 1280 px.**
`src/sdk/ui/incident-workspace.ts:779-781` : `ws-wide` n'est défini qu'à partir de 1280 px.
`src/sdk/ui/incident-ux.ts:1183` (deux colonnes « main graph » entre 960 et 1280).

- Reproduire : à 1100 px, ouvrir l'onglet Backend. Le code n'a que 368 px pour un contenu de 982 px, à
  côté du graphe (370 px). Le panneau contextuel, vide, prend 756 px en dessous. À 1440 px, le code
  dispose de 500 px. Capture : `light-1100-backend.png`.
- Correction : ajouter
  `@container (min-width:960px){.ws-ux-shell.ws-wide{grid-template-columns:minmax(0,1fr);grid-template-areas:"main" "graph" "aside"}}`
  avant la règle des 1280 px.

**M6. Graphe illisible à « 100 % », dans la zone latérale comme dans l'onglet Traçabilité.**
`src/sdk/ui/incident-graph.ts:928` (`preserveAspectRatio="xMidYMid meet"`, mise à l'échelle sur la
largeur du cadre) et `incident-graph.ts:851` (pourcentage affiché).

- Mesures : le graphe fait 2152 unités de large et s'affiche avec une échelle de 0,33 (1440, onglet),
  0,26 (1100) et environ 0,19 (vue d'ensemble à 1440). Les libellés de 12 px font donc 3 à 4 px et ne se
  lisent pas, alors que l'indicateur annonce « 100 % ». Le contour de focus d'un nœud (`stroke-width:3`,
  `incident-graph.ts:1119`) fait environ 1 px à l'écran : le focus clavier y est quasi invisible.
  Captures : `graph-1440-traceability.png`, `light-1440-overview.png`.
- Correction :
  - afficher l'échelle réelle (100 % = 1 unité par pixel) ;
  - fixer une échelle minimale lisible (environ 0,7), avec un cadre qui défile et se centre sur le chemin
    d'erreur ou la sélection ;
  - dans la zone latérale, afficher un aperçu avec « Ouvrir la traçabilité » ;
  - pour le focus, ajouter `vector-effect:non-scaling-stroke` sur `.ws-graph-box` ou un contour HTML
    autour du cadre.

### Mineurs

- **m1. Zones live recréées à chaque dessin.**
  - Fichiers : `incident-graph.ts:851` (`output.ws-graph-pct`), `incident-timeline.ts:768`
    (`.ws-timeline-count`), `incident-code.ts:1793` (résultats de recherche), `incident-graph.ts:865`
    (`role="status"` du chemin d'erreur).
  - `paint()` réécrit toute la racine fantôme. Chaque zone est donc un nœud neuf à chaque clic, et son
    annonce n'est pas fiable (en général rien n'est dit). Cela contredit `ux-spec.md` §3, qui demande une
    seule zone live.
  - Pendant le suivi, le bruit est limité : redessin seulement quand la révision change. Pendant une
    vraie reproduction, on a observé 1 redessin et le focus est resté sur l'onglet.
  - Correction : retirer `aria-live` de ces trois éléments et dire les changements par la zone
    `.inc-live`. Par exemple, « Zoom 125 % » et « 4 événements sur 35 » seulement après une action de
    l'utilisateur, jamais pendant le suivi.
- **m2. Les 21 nœuds du graphe sont tous des arrêts de tabulation.**
  - Fichier : `incident-parts.ts:123` (`selectable` avec `focusable`).
  - Il faut 21 appuis sur Tab pour traverser le graphe, alors que les flèches entre voisins existent déjà.
  - Correction : tabindex itinérant (un seul nœud à `0`, les autres à `-1`).
- **m3. La barre d'onglets et la progression débordent sans indice visuel.**
  - Fichier : `incident-ux.ts:1144`.
  - À 1440 px, 5 onglets sont hors champ (contenu de 1641 px pour 1096 px), et la dernière étape
    « Non-régression » est coupée.
  - À 390 px, `overflow-wrap:anywhere` (`incident-ux.ts:1135`) coupe « Environnemen/t ».
  - Correction : ombre de bord ou passage à la ligne des onglets au-delà de 1280 px, et
    `overflow-wrap:normal` pour les libellés d'étape.
- **m4. ARO : un champ invalide n'a pas son propre message.**
  - Fichier : `incident-ux.ts:1029`.
  - Le champ porte `aria-invalid="true"` sans `aria-describedby` vers un message. Seule l'alerte
    générale « Compléter les champs signalés… » le signale.
  - Correction : ajouter un `<small id="…-e">` par champ (« Champ obligatoire ») et le lier.
- **m5. La durée d'une action est étiquetée « Statut ».**
  - Fichier : `incident-workspace.ts:516` (`row(t.eventStatus, t.duration(...))`).
  - Correction : ajouter un libellé « Durée ».
- **m6. Thème sombre : texte blanc sur l'accent à 2,9:1.**
  - Fichiers : `dashboard-styles.ts:83` (`.btn.primary`) et `dashboard-styles.ts:261`
    (`.chip[aria-pressed="true"]`).
  - Le défaut est antérieur au Workspace mais très visible : les 4 puces de couches du graphe sont
    toujours enfoncées, et les boutons « Enregistrer l'environnement », « Confiance » et « Ajouter à la
    bibliothèque » sont concernés.
  - Correction, conforme à `ux-spec.md` §5 : `color:var(--qa-color-surface)` sur l'accent rempli.

## Vérifié correct

- **Onglets** : les 15 onglets fonctionnent, avec `role=tablist/tab/tabpanel` et un seul `tabindex=0`.
  ←/→/Début/Fin déplacent la sélection et le focus.
- **Progression** : les 10 étapes mènent à l'onglet prévu. `aria-current="step"` est sur l'étape
  actuelle (incident vide : « Reproduction »).
- **Graphe** :
  - zoom +/− (125 %, 80 %), « Tout voir », « Réinitialiser » ;
  - couches avec `aria-pressed` (BFF masqué : 21 → 15 nœuds) ;
  - chemin d'erreur avec `role=status`, 15 éléments sur le chemin, « 0 observée(s) … relations
    statiques » ;
  - molette (157 %), glisser (viewBox déplacée), touches `+`, flèches et `0` dans le cadre ;
  - Entrée et Espace sur un nœud, → vers son voisin, Échap vide la sélection en gardant le focus.
- **Nœuds et relations** : les 21 nœuds ont un détail. Les 16 nœuds de code ont un extrait avec la ligne
  en évidence et aucune durée affichée. La sélection d'une relation depuis la table montre son détail et
  la met en évidence dans le graphe. Aucune relation lue dans le code n'apparaît comme « Observée ».
- **Chronologie** :
  - les restrictions par couche, étape et statut changent le compte (35 → 14, 4, 5…) ;
  - « requêtes en erreur » donne 17, « reliés à la sélection » donne 4, « réinitialiser » revient à 35.
- **Sélection synchronisée** :
  - **Requête** : choisir `POST /api/books` met 8 nœuds en évidence et en atténue 13. Le panneau montre
    le détail (500, NullPointerException) et le code relié (`BookController.java:28`, ligne en évidence).
    Dans la chronologie, 12 éléments sont reliés.
  - **Hypothèse** : 16 nœuds du graphe sont reliés.
  - **Couverture** : 139 sélectionnables parcourus. Hors M2, aucune sélection vide.
  - **Liens de code** : les 10 liens `ws-code` ouvrent le bon fichier dans l'onglet de sa couche, ligne
    en évidence.
- **Frontend** : focus d'étape (`aria-current="step"`) et « étape en échec » fonctionnent.
- **Code** :
  - dossier repliable (`aria-expanded` passe de true à false) ;
  - ouverture de fichier ;
  - recherche (« 2 fichier(s) trouvé(s) », focus conservé, champ nommé) ;
  - « aller à » ;
  - erreur 500 simulée : `role=alert`, puis « Réessayer » recharge le fichier.
- **Hypothèses et expériences** :
  - **Hypothèses** : dépliage (`aria-expanded`) et 8 boutons « planifier ».
  - **Expérience à effets de bord** : expérience INTEGRATION_TEST (`APPROVAL_REQUIRED`). « Examiner avant
    d'exécuter » ouvre l'approbation (`role=group`, focus sur « Approuver »). Échap la ferme et rend le
    focus au bouton d'origine.
- **Rapport** : les exports JSON et Markdown sont réellement téléchargés (`incident-<id>.json` et `.md`),
  avec un message dans la zone live.
- **Environnement** :
  - radios en `role=radiogroup` avec tabindex itinérant et flèches ;
  - ARO vide : 4 champs en `aria-invalid`, focus sur le premier, alerte affichée ;
  - REMOTE : enregistré, « Environnement d'exécution enregistré. », l'en-tête affiche « Distant ».
- **Annuler et reprendre** :
  - « Annuler » met le focus sur la confirmation ;
  - après confirmation, le bandeau « Investigation annulée à l'état « Diagnostiqué »… » apparaît, le
    focus va sur « Reprendre » ;
  - la reprise retire le bandeau.
- **Démonstration** :
  - aucune requête vers `/api/projects/*/incidents` pendant l'exploration des 15 onglets, sélections et
    liens de code compris, ni pendant 4 s d'attente (pas de suivi) ;
  - toutes les actions qui modifient l'incident sont désactivées, avec un motif ;
  - diagnostic PROBABLE et bandeau affiché.
- **Lecteur** :
  - aucune demande de code ;
  - panneaux « Votre rôle ne permet pas de lire le code du périmètre. » (onglet Backend et panneau
    contextuel) ;
  - aucune action qui modifie l'incident ; seuls l'export et la relecture du rapport restent (lecture
    VIEW) ;
  - l'API répond 403 sur `/sources` ;
  - 403 forcé par interception : écran « refusé ».
- **Incident vide** : chaque onglet affiche un état vide qui dit quoi faire (« Lancer la reproduction… »,
  « Le graphe apparaît après l'analyse… »), sans erreur.
- **Vérité** :
  - « Cause racine confirmée » n'apparaît jamais (diagnostic PROBABLE, réel et démo) ;
  - la non-régression affiche « Échoué » quand `execution.passed === false` ;
  - aucune durée sur les nœuds de code ;
  - les relations statiques ne sont jamais présentées comme observées.
- **Absences vérifiées** : aucun identifiant en double dans la racine fantôme (15 onglets), aucun élément
  interactif sans nom accessible, aucune référence ARIA cassée, aucune image sans `alt`, aucune erreur
  JavaScript dans la page.

## Accessibilité (synthèse)

- **Clavier** : tout le parcours est possible au clavier. L'ordre de tabulation suit l'ordre visuel :
  en-tête, progression, onglets, contenu, graphe, panneau. Pas de piège. Le focus reste sur son élément
  après chaque redessin, y compris pendant le suivi. Il reste visible partout (contour de 2 à 3 px), sauf
  sur les nœuds du graphe (M6).
- **Rôles et noms** : conformes (voir « Absences vérifiées »).
- **Zones live** : m1.
- **Contraste** : M3 et m6.

## Responsive

- **Défilement de la page** : M1 à toutes les largeurs.
- **Code serré** : M5 entre 960 et 1280 px.
- **Graphe** : M6.
- **Table des relations** : M4.
- **Débordements internes** : m3.
- **390 px** : une seule colonne, menu replié, cartes empilées, aucun élément hors cadre en dehors des
  zones qui défilent.

Captures de la revue (non versionnées, prises hors du dépôt).
On y trouve `{light,dark}-{1440,390}-<onglet>.png`, les onglets overview, traceability, backend et
diagnosis à 1100 et 800, ainsi que `reltable-1440.png`, `graph-1440-traceability.png`,
`backend-code-1440.png`, `approval-1440.png`, `cancelled-1440.png`, `error-500-backend.png` et
`empty-report.png`.

## Tests

| Suite                                                                  | Résultat                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --project unit` (complet)                              | 1 échec, 2526 réussis, 1 ignoré (2528 ; 235 fichiers). L'échec est `git-source.test.ts > RULES…` (délai de 5038 ms dépassé pendant que le serveur de revue tournait) ; relancé seul : 8/8 réussis. |
| `tests/integration/incident-reconstruction.test.ts` (`--maxWorkers=1`) | 8/8 réussis                                                                                                                                                                                        |
| `tests/integration/sdk-dashboard.test.ts`                              | 11/11 réussis                                                                                                                                                                                      |
| `tests/integration/sdk-dashboard-access.test.ts`                       | 4/4 réussis                                                                                                                                                                                        |
| `tests/integration/incident-workspace-review.test.ts` (nouveau)        | 6 réussis, 4 en échec (défauts M1, M2, M3, M4 ; assertions marquées `// DEFECT:`)                                                                                                                  |

Tests réussis du nouveau fichier :

- parcours clavier (onglets itinérants, focus visible, Entrée et Échap sur un nœud, requête au clavier) ;
- démonstration sans appel aux incidents et sans action active ;
- sélection synchronisée (requête → graphe, panneau, code ; restriction de la chronologie ; nœud de code
  sans durée ; aucune relation statique observée ; hypothèse → graphe) ;
- lecteur (aucune demande de code, panneau refusé, aucune action, 403 de l'API) ;
- erreur 500 sur le code avec un « Réessayer » qui fonctionne ;
- ids uniques, noms accessibles, références ARIA et `alt` sur les 15 onglets.

## Corrections (après la revue)

Tous les défauts ci-dessus sont corrigés ; les quatre assertions `// DEFECT:` de
`tests/integration/incident-workspace-review.test.ts` sont gardées et passent (10/10).

| Défaut | Correction                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | barre d'onglets et progression positionnées ; aucun défilement horizontal de la page à 390, 800, 1100 et 1440 px sur les quinze onglets                                                     |
| M2     | `evidenceChips` résout chaque référence par l'index des liens (`links.refs`) : requête, preuve, symbole ou vérification ; une référence sans élément sélectionnable reste une puce de texte |
| M3     | textes colorés en `color-mix(<statut> 55–80 %, --qa-color-text)`, numéros de ligne en `--qa-color-muted` : ≥ 4,5:1 en thème clair et sombre (badges de relation 4,93 à 7,78:1)              |
| M4     | colonnes De / Vers d'au moins 148 px, coupure aux mots, raison compacte                                                                                                                     |
| M5     | graphe en bande pleine largeur (≥ 1280 px), contenu et panneau dessous ; sur les onglets de code, la bande passe sous le code                                                               |
| M6     | l'indicateur donne l'échelle réelle ; échelle lisible minimale 85 % (le cadre défile) ; « Vue d'ensemble réduite » en dessous ; contour de focus à trait constant                           |
| m1     | plus de zone `aria-live` dans les vues ; annonces une fois, par la zone `.inc-live` du Dashboard                                                                                            |
| m2     | un seul arrêt de tabulation dans le graphe, qui suit les flèches                                                                                                                            |
| m3     | onglets sur plusieurs lignes ; progression sur une ligne, deux lignes de cinq, ou défilement avec ombre de bord                                                                             |
| m4     | message d'erreur propre au champ ARO, relié par `aria-describedby`                                                                                                                          |
| m5     | « Durée »                                                                                                                                                                                   |
| m6     | thème sombre : texte sur l'accent en `--qa-color-surface` (≈ 5,6:1)                                                                                                                         |

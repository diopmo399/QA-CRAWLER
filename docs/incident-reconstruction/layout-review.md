# Revue responsive et accessibilité : Investigation Workspace v2

Revue menée dans Chromium (Playwright) sur une vraie investigation (fixture « Catalogue » reproduite,
analysée, expérience exécutée, diagnostic PROBABLE) et sur le jeu de démonstration, aux tailles
1440 × 900, 1366 × 768, 1280 × 800, 1024 × 768, 820 × 1180, 390 × 844, thèmes clair et sombre, plus un
zoom 200 % émulé (720 × 450 et 683 × 384 à `deviceScaleFactor` 2). Les seize vues (six onglets et leurs
sous-onglets) ont été mesurées une par une. Scripts, mesures JSON et captures : dossier
`layout-review/` du répertoire de travail temporaire de la revue (captures dans `layout-review/shots/`,
notées `shots/…` ci-dessous). Les numéros de ligne sont ceux des sources au moment de la revue.

## Verdict

**Non conforme en l'état : 2 défauts bloquants, 6 majeurs, 9 mineurs.** La disposition par défaut d'une
vraie investigation tient ses promesses (aucun défilement de la page sur ordinateur, graphe et code visibles
ensemble, panneaux redimensionnables et indépendants, clavier complet), mais deux situations courantes
rendent du contenu inaccessible : la progression complète ou les « Détails » de l'en-tête ouverts, et la
démonstration sous 1366 × 768. L'accessibilité a des écarts mesurables : contraste des séparateurs et des
anneaux de focus, zone live recréée à chaque redessin, focus perdu.

## Défauts bloquants

### B1. Progression dépliée ou « Détails » ouverts : les panneaux sont coupés sans défilement

- **Reproduction** : Traçabilité › Full Stack, cliquer la flèche de la progression (`ws-ux-stepper`),
  puis éventuellement « Détails » (`ws-ux-details`). La préférence `stepper` est mémorisée pour toutes
  les investigations : l'état persiste.
- **Mesure** (hauteur du corps `.ws-body`, pixels de panneaux sous le bas de `.ws-root`, éléments
  interactifs inatteignables) :

  | Fenêtre         | Progression seule                              | Progression + Détails                                               |
  | --------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
  | 1440 × 900      | corps 545, 0 coupé                             | corps 345, 21 px coupés, 89 inatteignables                          |
  | 1366 × 768      | corps 413, 0 coupé                             | corps 213, 153 px coupés, 103 inatteignables                        |
  | 1280 × 800      | corps 319, **47 px coupés, 89 inatteignables** | corps 119, 247 px coupés, 109                                       |
  | 1024 × 768      | corps 275, **91 px coupés, 92 inatteignables** | corps **24**, 342 px coupés, 119                                    |
  | 1024 × 768 démo | —                                              | corps **0** : les onglets eux-mêmes sont coupés, 138 inatteignables |

  Le document ne défile pas (`scrollHeight = innerHeight`) : la partie coupée est perdue.

- **Captures** : `shots/1024x768-real-chrome-open.png`, `shots/1024x768-demo-chrome-open.png`,
  `shots/1024x768-stepper-only.png`, `shots/1440x900-header-stepper-open.png`.
- **Cause** : `.ws-root{overflow:hidden}` et `.ws-root>*{flex:none}`
  (`src/sdk/ui/incident-workspace.ts:1057`, `:1059`) ; la grille garde ses minimums
  (`minmax(200px,…) 6px minmax(160px,…)`, `src/sdk/ui/incident-split.ts:404`, `ZONE_MIN_PX` `:80`) alors
  que le corps descend sous 366 px ; `.ws-ux-head-more{max-height:32vh}` (`incident-ux.ts:1264`) et la
  progression ouverte (127 à 223 px) ne sont pas bornées par la place restante.
- **Correctif proposé** : donner un plancher au corps (`.ws-root>.ws-body{min-height:380px}`) et laisser
  `.ws-root` défiler verticalement seulement dans ce cas (`overflow:hidden auto`) ; ou poser la progression
  complète et les « Détails » en surcouche (popover ancré, `max-height` calculée) ; au minimum, ne pas
  rouvrir la progression complète d'office au chargement quand `innerHeight < 900`.

### B2. Démonstration : graphe invisible et zone basse coupée à 1024 × 768, graphe réduit à une bande jusqu'à 1366 × 768

- **Reproduction** : Investigations › « Ouvrir la démonstration », onglet Traçabilité, sans rien déplier.
- **Mesure** : chrome au-dessus des onglets 115 px (1440), 145 (1280), 186 (1024, 820), 299 (390) contre
  66 / 96 / 108 / 200 pour une vraie investigation ; note « action indisponible » 32 à 51 px ; bandeau
  répété dans le panneau du graphe et dans « Preuves ». À 1024 × 768 : zone basse 27 px sous le bas de
  `.ws-root` (89 éléments inatteignables), corps du panneau graphe 321/163 px, le cadre du graphe est hors
  de la partie visible. À 1366 × 768 et 1280 × 800 : cadre 124 px, corps 300/197 px, une ligne de nœuds
  visible.
- **Captures** : `shots/1024x768-light-demo-traceability-fullstack.png`,
  `shots/1366x768-light-demo-traceability-fullstack.png`.
- **Cause** : `demoBanner()` rendu quatre fois (en-tête `incident-ux.ts:997`, graphe
  `incident-workspace.ts:769`, preuves `incident-code.ts:2556`, plus la note `#ws-demo-why`), plus la cause
  de B1 pour la coupe.
- **Correctif proposé** : un seul bandeau compact d'une ligne dans l'en-tête (le libellé « [Démo] » du titre
  reste), la note « action indisponible » repliée dans une infobulle ou un `<details>` ; dans les panneaux,
  une pastille « Démo » dans la barre de titre au lieu du bandeau complet.

## Défauts majeurs

### M1. La zone live est recréée à chaque redessin (annonces répétées ou perdues)

- **Reproduction** : Diagnostic › Expériences, planifier « Inspecter les journaux » (message « Vérification
  planifiée. »), puis 5 flèches sur un séparateur et un changement de sous-onglet.
- **Mesure** : 7 actions de disposition → **14 réinsertions** de `p.inc-live[role=status]` portant le même
  texte (observateur de mutations). Selon le lecteur d'écran, soit le message est relu, soit les vrais
  changements ne sont pas annoncés (une zone live doit exister avant que son texte change). Le message reste
  affiché indéfiniment (20 px pris au corps).
- **Cause** : la zone est dans le gabarit (`src/sdk/ui/dashboard-incidents.ts:361`) et le Shadow DOM est
  réécrit par `innerHTML` à chaque `paint()` (`src/sdk/ui/dashboard.ts:3000`).
- **Correctif proposé** : un nœud live permanent hors de la partie redessinée (créé une fois à la connexion
  de l'élément), dont seul `textContent` change quand le message change ; effacement après quelques
  secondes.

### M2. Focus perdu après « Replier l'arborescence »

- **Reproduction** : onglet Code, focus sur le bouton « Replier l'arborescence » de l'explorateur, Entrée.
- **Mesure** : 1440 × 900 et 820 × 1180 : `activeElement` du Shadow DOM `null`, focus sur `BODY` ; le seul
  bouton « Afficher l'arborescence » restant est dans le corps masqué du panneau réduit (visible = false).
- **Cause** : `ws-code-tree-toggle` met le panneau `tree` en `min`
  (`incident-workspace-controller.ts:1170-1172`) ; le corps d'un panneau réduit porte `hidden`
  (`incident-split.ts:542`) ; `paint()` refocalise le premier bouton de même action, invisible.
- **Correctif proposé** : après l'action, focaliser `#ws-pane-tree .ws-pane-ops [data-op="restore"]` ; ou
  ne pas masquer le corps du panneau `tree` réduit pour que le rail de l'explorateur reste utilisable.

### M3. Contraste des séparateurs, des bordures et des anneaux de focus sous 3:1

- **Mesure** (1440 × 900, couleurs composées) :
  - poignée de séparateur au repos (`border-strong` à 70 %) : **1,27:1** clair (#d9dbeb sur #f5f6fb),
    **1,57:1** sombre ; au survol ou au focus elle passe à l'accent (5,83:1 / 6,46:1) ;
  - bordure de panneau : 1,21:1 extérieur / 1,30:1 intérieur (clair), 1,47 / 1,35 (sombre) ; bordure de
    « Mode compact » 1,21:1 / 1,47:1 ;
  - anneau de focus générique (accent à 45 %) sur les boutons de panneau, « Mode compact », la bascule de
    progression, « Incidents » : **2,04 à 2,09:1** clair, **2,20 à 2,27:1** sombre ; contour du séparateur
    focalisé 2,46 / 2,75 (compensé par la poignée pleine).
  - Conformes : onglets, cadre du graphe, fichiers, champs, « Légende et aide », « Détails » (5,83 à 6,46:1).
- **Captures** : `shots/1440x900-light-real-traceability-fullstack.png`,
  `shots/1440x900-dark-real-traceability-fullstack.png`.
- **Cause** : `.ws-splitter::after{background:var(--qa-color-border-strong);opacity:.7}`
  (`incident-split.ts:848`) ; `:focus-visible` global à 45 % (`dashboard-styles.ts:42`) non surchargé
  pour `.ws-pane-btn` (`incident-split.ts:833`), `.ws-tool` (`incident-workspace.ts:1065`),
  `.ws-ux-step-toggle`, `.back`.
- **Correctif proposé** : poignée en `var(--qa-color-muted)` sans opacité (≥ 3:1 dans les deux thèmes) ;
  `.ws-pane-btn:focus-visible,.ws-tool:focus-visible,.ws-chip-btn:focus-visible,.ws-ux-step-toggle:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}`.

### M4. Texte atténué illisible pendant une sélection

- **Mesure** : avec un nœud sélectionné, **543 éléments** de texte (dont des boutons encore cliquables)
  entre **1,37 et 2,90:1** en clair, 1,39 et 3,89:1 en sombre (`.ws-dimmed` à .45, .3 dans le SVG, .2 quand
  deux atténuations s'imbriquent).
- **Cause** : `.ws-dimmed{opacity:.45}` (`incident-parts.ts:211`), `.ws-graph svg .ws-dimmed{opacity:.3}`
  (`incident-graph.ts:1363`).
- **Correctif proposé** : atténuer le fond et les traits, pas le texte (couleur `--qa-color-muted`, ≥ 4,5:1),
  ou une opacité ≥ .75 sans imbrication (`.ws-dimmed .ws-dimmed{opacity:1}`).

### M5. Barre d'outils compacte du graphe : boutons cachés derrière un défilement horizontal

- **Mesure** (Full Stack, `scrollWidth/clientWidth` de `.ws-graph-bar`, boutons hors de la barre) :
  1440 × 900 844/773 (« Plein écran ») ; 1366 × 768 844/721 (Données, Plein écran) ; 1280 × 800 844/661
  (Backend, Données, Plein écran) ; 1024 × 768 777/436 (Frontend, BFF, Backend, Données, Plein écran) ;
  820 × 1180 777/488 (4 boutons). Atteignables au clavier (Tab fait défiler) ou par la fine barre de
  défilement, mais invisibles. 390 × 844 : retour à la ligne (4 lignes, 130 px).
- **Captures** : `shots/toolbar-before-1024x768-real.png`, `shots/toolbar-before-1440x900-real.png`.
- **Cause** : `.ws-graph-compact .ws-graph-bar{flex-wrap:nowrap;overflow-x:auto}` (`incident-graph.ts:1404`),
  retour à la ligne seulement sous 400 px de conteneur (`:1427`).
- **Correctif proposé** : en cours chez le lead (voir « Contre-vérification » en fin de document).

### M6. Séparateurs : `aria-valuemin`/`aria-valuemax`/`aria-valuenow` ne disent pas la position réelle

- **Mesure** : `aria-valuemin="8"`, `aria-valuemax="92"` sur tous les séparateurs, alors que Début/Fin donnent
  28 et 77 (1440, graphe | détails) ou 44 et 64 (1024). À 1024 × 768, `aria-valuenow="70"` alors que la
  position rendue est 64 % (détails à leur minimum de 260 px) : la première flèche → fait passer la valeur
  de 70 à 64 sans mouvement visible.
- **Cause** : `renderSplitter` calcule les bornes sans la taille de la zone (`incident-split.ts:555`,
  `splitBounds(id, ui.sizes)`) et publie la fraction mémorisée, pas la fraction rendue.
- **Correctif proposé** : mémoriser la taille de chaque zone (déjà mesurée par le contrôleur au clavier et
  au glisser) dans `SplitUi`, calculer `splitBounds(id, sizes, total)` au rendu et publier la valeur bornée.

## Défauts mineurs

1. **Onglets de fichiers** : le `role="tablist"` contient les boutons « Fermer … » (3 éléments focalisables
   qui ne sont pas des onglets, règle « enfants requis » d'ARIA). Cause `incident-code.ts:2443`. Sortir les
   boutons de fermeture du `tablist` (`aria-owns` sur les seuls onglets) ou les rendre `tabindex="-1"` et
   fermer par Suppr (déjà géré).
2. **En-tête pas sur une ligne** : 66 px à 1440, 96 px à 1280 (pastilles à la ligne), 108 px à 1024 (actions
   à la ligne), 200 px à 390 ; démo jusqu'à 186 px. Cause `incident-ux.ts:1254-1256` (`flex-wrap`, titre en
   `flex:1 1 200px`). Passer les actions en boutons icônes dès 1280 (la règle existe à 980 px de conteneur,
   `incident-workspace.ts:1058`) et garder les pastilles sur la ligne du titre.
3. **`.ws-notes` affichée vide** : elle contient la zone live vide, donc `:empty` ne joue pas ; 8 px d'écart
   perdus (`incident-workspace.ts:1063`). Masquer quand `.inc-live` est vide (`:has()`), ou déplacer la
   zone live (M1).
4. **Séparateurs de 6 px** : cible de pointeur étroite (critère 2.5.8 tenu par l'espacement, mais
   difficile à saisir). Élargir la zone active à 12 px par un pseudo-élément sans changer la piste visuelle
   (`SPLITTER_PX`, `incident-split.ts:82`).
5. **Mode compact** : gain de 29 px seulement (en-tête 66→62, onglets 38→37, sous-onglets 32→28) ; cadre du
   graphe 242→263 px. Réduire aussi la progression et masquer les compteurs.
6. **Arborescence étroite** : 191 px à 1440, 160 px à 1024 et 820 ; noms coupés à 3 ou 4 lettres
   (« Boo… », « Cata… », infobulle présente) : `shots/1440x900-light-real-code--.png`. À la tablette,
   l'arborescence n'est pas réduite par défaut (le contrat la voulait réduite ; `ux-spec.md` § 4 documente
   le choix d'un rail à la demande).
7. **Défilement mémorisé par panneau, pas par vue** : Périmètre défilé à 600 px → Résumé → Périmètre :
   330 px ; Résumé s'ouvre déjà défilé. Clé de mémoire = pane id seul (contrôleur, sauvegarde des
   défilements). Clé `vue + panneau`.
8. **Approbation d'une expérience à effets de bord** : le focus va sur « Approuver et exécuter » (bouton
   danger) : Entrée lance l'exécution. Focaliser « Annuler » ou le titre de l'encart
   (`shots/1366x768-approval.png`).
9. **Contrastes isolés** : badge « Lue dans le code » 4,29:1 sur fond « lié » (clair, 14 occurrences,
   `incident-parts.ts`) ; lien `.lnk.ws-related` 4,38:1 (sombre). Onglet « Rapport » tronqué « Rappo » à
   1024 × 768 en démo (la barre défile, sans indice visuel). Hors périmètre : la marge de la page autour du
   Dashboard reste claire en thème sombre.

## Vérifié conforme

- **Pas de défilement global sur ordinateur** : `scrollHeight − innerHeight = 0` et aucun défilement
  horizontal pour les 16 vues, réel et démo, clair et sombre, à 1440 × 900, 1366 × 768, 1280 × 800,
  1024 × 768 et 820 × 1180 (état par défaut). `scrollWidth = innerWidth` partout, y compris 390 × 844 et le
  zoom 200 %.
- **Graphe et code ensemble** (réel) : cadre du graphe 773 × 242 (1440), 721 × 165 (1366), 661 × 166 (1280),
  436 × 141 (1024), 488 × 333 (820), entièrement dans la fenêtre, éditeur sous lui. Onglet Code : zone
  haute réduite à ses barres, éditeur 639 × 497 (1440) à 346 × 264 (1024), défilement propre
  (665/497), molette dans le code sans bouger la page ni l'arborescence.
- **Panneaux** : chaque corps défile seul (molette dans Périmètre : 600 px, détails 0, page 0) ; aucun
  panneau ne déborde de sa boîte dans l'état par défaut ; aucun texte coupé sans ellipse, aucune ellipse
  sans infobulle (détecteur sur toutes les vues).
- **Séparateurs** : `role="separator"`, `tabindex="0"`, orientation, libellé (« Redimensionner : Graphe et
  Détails »), `aria-controls` valide, aide liée ; ← → ↑ ↓ 2 %, Maj 10 %, Début/Fin aux minimums réels
  (graphe 320 px, détails 260 px, zone haute 200, basse 160), Entrée réduit puis rétablit avec focus sur le
  bouton du panneau, double clic rétablit 70 %, glisser au pointeur (791 → 637 px, posé en direct), focus
  gardé après chaque redessin, préférences écrites (`qa-crawler:incident-workspace:v2`).
- **Boutons de panneau** : 15 boutons, tous libellés ; `aria-pressed` (agrandir), `aria-expanded` +
  `aria-controls` (réduire) ; réduire/rétablir/masquer/afficher/agrandir gardent ou déplacent le focus de
  façon cohérente (barre « Panneaux masqués » focalisée après masquage) ; Échap rétablit le panneau agrandi
  (graphe agrandi 1118 × 515) avec focus sur « Agrandir », avant de vider la sélection.
- **Onglets** : une ligne pour la barre principale et les sous-onglets sur ordinateur et tablette
  (défilement horizontal propre à 390 px, onglet actif visible) ; `tablist`/`tab`/`tabpanel`, un seul
  `tabindex="0"`, `aria-selected`, `aria-controls="ws-ux-panel"`, panneau relié au sous-onglet ; ← → Début Fin
  sur onglets, sous-onglets et onglets de fichiers ; aucun identifiant dupliqué.
- **Ordre du focus** : menu → en-tête (retour, actualiser, actions, Détails) → progression → onglet actif →
  outils → sous-onglet actif → graphe → séparateur → détails → séparateur → fichiers…, aucun élément
  focalisé hors de la fenêtre.
- **Synchronisation** : nœud « POST /api/books → 500 » sélectionné au clavier → 1 sélectionné, 39 liés,
  122 atténués ; détails du nœud ; l'éditeur ouvre `BookController.java` (`revealInCode`) ; HTTP 2 liés,
  Chronologie 11, Hypothèses 8, Code 1 sélectionné + 9 lignes signalées liées ; Échap vide tout ; focus
  gardé sur le nœud.
- **Éditeur** : Ctrl+G ouvre « Aller à la ligne », ligne 30 → défilement 228 px, focus sur le code, Échap
  ferme et rend le focus au bouton ; recherche « response » → « Résultat 2 sur 2 ».
- **Fonctions conservées** : périmètre (6 sections, édition), environnement (radiogroupe, flèche →
  REMOTE, 3 champs, enregistrer), rapport (export JSON/Markdown, actualiser), non-régression (« Proposer un
  test »), expériences (planifier, encart d'approbation, Échap annule et rend le focus à « Examiner… »),
  progression (11 boutons d'étape, Reproduction → Chronologie/Événements), démo (bandeau, boutons désactivés
  avec motif), aucune erreur de page ni de console.
- **Tablette 820 × 1180** : disposition à deux zones (graphe 506, détails 260, fichiers 160, code 400,
  preuves 200), rail de l'arborescence au clic (éditeur 400 → 499 px).
- **Mobile 390 × 844** : hauteur naturelle, un seul panneau (796 px), sélecteur Graphe / Détails / Fichiers /
  Code / Preuves (`aria-pressed`, cibles ≥ 40 px), pas de séparateur ; une sélection garde le panneau et
  propose « Voir le détail » ; documents en Contenu / Détails ; aucune cible sous 24 px.
- **Zoom 200 %** (720 × 450, 683 × 384) : repli en hauteur naturelle, aucun défilement horizontal, aucun
  élément inatteignable sur les 16 vues.
- **Mouvement réduit** : règles `prefers-reduced-motion` présentes (progression, graphe, chronologie,
  diagnostic, trace frontend) ; aucune animation en cours mesurée ; la disposition n'anime rien.
- **Contraste du texte non atténué** : 2 653 textes mesurés par thème sur 10 vues : 1 écart chacun (mineur 9).

## Contre-vérification finale (serveur relancé sur les sources de 11 h 42)

- **M5, barre d'outils du graphe** : `incident-graph.ts` inchangé depuis 11 h 15 ; mesures identiques
  (Full Stack : 844/773 à 1440, 777/436 à 1024, « Plein écran » caché de 1440 à 820 ; 4 lignes à 390).
  Le correctif annoncé n'est pas encore dans les sources : à revérifier quand il arrive
  (`shots/toolbar-after-*.png`).
- **B1, B2, M2** : inchangés (progression seule : 47 px coupés à 1280 × 800, 91 px à 1024 × 768 ; démo
  1024 × 768 : 27 px coupés, 89 inatteignables ; focus sur `BODY` après « Replier l'arborescence »).
- 41 autres vues remesurées à 1440 × 900 et 1024 × 768 : aucun défilement du document, aucun défilement
  horizontal, aucun élément inatteignable.

## Corrections (après la revue)

| Constat | Correction                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1      | plancher de 380 px pour la zone des panneaux ; l'espace défile seulement quand il est atteint (progression et « Détails » dépliés) : 0 élément inaccessible à 1440, 1366, 1280 et 1024                                                                                      |
| B2      | bandeau de démonstration affiché une fois, sur une ligne, dans l'en-tête (`demoInShell`) ; démo à 1024×768 : rien de rogné, canevas de 147 px                                                                                                                               |
| M1      | zone vivante permanente hors de l'arbre redessiné ; 0 réinsertion après 7 actions                                                                                                                                                                                           |
| M2      | après « Replier l'arborescence », le focus va au bouton qui rouvre le panneau                                                                                                                                                                                               |
| M3      | séparateurs 6,73 / 8,27:1, bordures 3,30 / 4,94:1, contours de focus ≥ 5,4:1 (clair / sombre)                                                                                                                                                                               |
| M4      | texte atténué en couleur atténuée (≥ 5,4:1) ; nœuds atténués du graphe 7,27 / 7,6:1                                                                                                                                                                                         |
| M5      | barre du graphe sur une ligne, tous les boutons visibles de 430 à 773 px (menu « Couches », plein écran en icône)                                                                                                                                                           |
| M6      | `aria-valuemin`, `aria-valuemax` et `aria-valuenow` calculés d'après la place réelle de la zone                                                                                                                                                                             |
| Mineurs | `.ws-notes` absent quand vide ; zone de saisie des séparateurs de 12 px ; arborescence de 225 px à 1440 ; défilement mémorisé par vue ; en-tête de 42 px à 1440 ; mode compact + 72 px ; focus initial sur « Annuler » dans l'approbation ; Échap ferme le menu « Couches » |

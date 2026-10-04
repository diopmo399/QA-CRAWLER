# Identité de cible contextualisée

```
LOCATOR FINDS CANDIDATES.        FINGERPRINT IDENTIFIES THE TARGET.
CONTEXT DISAMBIGUATES.           WORKFLOW EXPLAINS.
SAFETY POLICY AUTHORIZES.        PLAYWRIGHT EXECUTES.
ACTION EFFECT VERIFIER CONFIRMS. RUNTIME DECIDES WHAT IS TRUE.
```

Un localisateur (`#valueInput`) n'est **pas** l'identité d'un élément : c'est une manière de trouver
des candidats.

- `locator ≠ target identity`
- `found element ≠ correct element`
- `unique CSS selector ≠ stable target`

## Audit : où l'identité se perdait

| Étape                   | Avant                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture                 | `capture-script.ts` décrit l'élément : rôle, nom, libellé, section, id, fenêtre, type. Le libellé de mat-form-field est lu.                                                                     |
| Localisateur enregistré | `resolveRecordedTarget` classe les candidats : libellé, rôle+nom, testId, `name`, formControlName, `#id`, CSS positionnel. Le candidat `#id` était marqué **unique sans compter les éléments**. |
| Empreinte               | Rôle, nom, texte, testId, balise, contexte, libellé, section, composant, formControl, placeholder, semanticId. **Ni la fenêtre, ni le champ, ni l'id, ni le voisinage.**                        |
| Rejeu (`locate`)        | Plusieurs correspondances : le premier élément visible d'une fenêtre, sinon le premier — **en silence**.                                                                                        |
| Candidats               | `discoverCandidates` / `scoreCandidates` / `decide` existent (résolution fonctionnelle), mais ne sont appelés **que si l'empreinte du premier élément ne correspond pas**.                      |
| `matchFingerprint`      | Nom 0,7, rôle 0,2, balise 0,1, section. Un verdict seul, sans le détail des preuves.                                                                                                            |
| Healing                 | `healTarget` (empreinte simple : rôle+nom, testId, texte) acceptait le premier élément au même nom, même d'un autre genre (le libellé « Company name » pour le champ « Company name »).         |
| Précondition de N+1     | La disponibilité de l'étape suivante utilisait le localisateur **brut**. Un localisateur périmé faisait déclarer NO_EFFECT à l'étape _précédente_.                                              |

**Pourquoi `#valueInput` était accepté à tort.** Quatre éléments correspondent. Le premier visible
d'une fenêtre est pris. Si son empreinte correspond « assez » (même rôle, même balise, pas de nom
enregistré : 0,7 = STRONG_MATCH), il est rempli. Playwright réussit, mais le critère n'est pas
appliqué, et la divergence n'apparaît que plusieurs étapes plus loin.

## Ce qui change

1. **Enregistrement : l'identité complète**, rétrocompatible car tous les champs sont facultatifs.
   - `id`, `inputType`, `dialog`, `formField` (mat-form-field, fieldset, groupe) ;
   - `nearbyText` (libellés, titres, boutons proches — jamais une valeur) ;
   - `stableAttributes` (`name`).

   Un id partagé (`sameId > 1`) n'est plus jamais un localisateur « unique ». Un ancien YAML sans
   ces champs reste valide.

2. **Rejeu : le localisateur génère des candidats.** S'il désigne **plusieurs** éléments
   (`replay.functionalTargetResolution.resolveNonUniqueLocators`, actif par défaut), la résolution
   contextuelle est **toujours** lancée, même si le premier élément « correspond »
   (`TARGET_LOCATOR_NON_UNIQUE`) :
   - les candidats sont classés ;
   - le meilleur est retenu seulement s'il dépasse le seuil (`minScore`) **et** devance nettement
     le deuxième (`ambiguityMargin`) ;
   - sinon `TARGET_AMBIGUOUS` : aucun choix arbitraire, rien n'est exécuté.
3. **Preuves et poids centralisés** (`TARGET_SCORE_WEIGHTS`), du plus fort au plus faible :
   - testId stable ;
   - libellé / nom, champ fonctionnel, concept métier ;
   - section, fenêtre (hors fenêtre : −) ;
   - attributs métier stables ;
   - parcours : contrôle précédent portant le dernier choix, action suivante, libellé égal à un
     choix récent ;
   - voisinage ;
   - structure : un id partagé presque rien, un localisateur positionnel `nth-…` 0,03.

   Écartés avant tout score : caché, désactivé, non éditable, autre section hors de la fenêtre.

   Le score n'est **pas plafonné** pour classer : deux candidats « saturés » resteraient sinon
   indiscernables, et la preuve du parcours qui les départage serait perdue. La confiance affichée
   est bornée à 1.

4. **`matchFingerprint` explique** :
   - composantes `identity` / `context` / `semantic` / `structural` ;
   - `matchedEvidence` / `mismatchedEvidence` ;
   - sévérité :
     - `SOFT` : fenêtre renommée, structure qui a bougé ;
     - `HARD` : autre nom, autre section, autre testId.
5. **Issue de résolution** :
   - `EXACT` (aucune résolution nécessaire) ;
   - `CONTEXTUAL_MATCH` ;
   - `HEALED` ;
   - `AMBIGUOUS` ;
   - `NOT_FOUND` ;
   - `MISMATCH`.

   Elle est accompagnée de `confidence` et de `ambiguity` (meilleur, deuxième, écart).

6. **Healing** :
   - **Localisateur introuvable.** Le healing par empreinte est tenté d'abord ; il refuse désormais
     un élément d'un autre genre (balise ou rôle incompatible). Ensuite vient le healing contextuel
     (`TARGET_HEALING_REQUESTED` → `TARGET_HEALED`).
   - **Apprentissage.** Il n'a lieu qu'après confirmation runtime. L'ActionEffectVerifier (clic) ou
     la valeur relue (saisie) confirme la cible : `TARGET_HEALING_CONFIRMED` → connaissance
     **candidate**, jamais une vérité globale. Effet contredit ou invérifiable :
     `TARGET_HEALING_REJECTED`, rien n'est appris.
7. **Précondition de l'étape suivante.** Si son localisateur brut ne trouve rien, la cible est
   cherchée par sa résolution contextuelle (lecture seule) : un localisateur périmé n'est pas la
   preuve qu'elle manque.

`TARGET_CONFIRMED` (« probablement la bonne cible ») ≠ `ACTION_CONFIRMED` (« l'effet attendu a eu
lieu ») : l'effet runtime reste la preuve finale.

## Ordre, synchronisation et intelligence

```
WAIT_FOR_PRECONDITION → WAIT_FOR_UI_STABILITY (synchronisation des transitions)
→ DISCOVER_TARGET_CANDIDATES → CONTEXTUAL_TARGET_RESOLUTION → SafetyPolicy → EXECUTE
→ WAIT_FOR_EXPECTED_EFFECT → VERIFY_EFFECT
```

La cible n'est résolue qu'après la transition de l'étape précédente (`docs/REPLAY_SYNCHRONIZATION.md`).

Le conseiller IA (si actif) n'est consulté qu'**après** la résolution déterministe :

- il choisit seulement parmi les candidats fournis, sans jamais inventer de localisateur ;
- il cite des preuves existantes ;
- sa proposition passe ensuite ProposalValidator, EvidenceValidator, SafetyPolicy et la
  vérification runtime (voir WORKFLOW_SELF_HEALING.md).

## Journal et rapport

Événements :

- `TARGET_LOCATOR_NON_UNIQUE`, `TARGET_CANDIDATE_DISCOVERED`, `TARGET_EVIDENCE`,
  `TARGET_CONTRADICTION` ;
- `TARGET_CONTEXTUAL_MATCH`, `TARGET_AMBIGUOUS` ;
- `TARGET_HEALING_REQUESTED`, `TARGET_HEALED`, `TARGET_HEALING_CONFIRMED`,
  `TARGET_HEALING_REJECTED` ;
- `TARGET_RESOLUTION`, dont la trace complète contient `recordedLocator`, `rawMatches`, les
  candidats, les scores, la sélection, la confiance et le statut.

Rapport HTML, bloc « Target resolution » :

- cible, localisateur enregistré, correspondances brutes ;
- cible retenue, contexte (fenêtre, champ, choix du parcours) ;
- issue, confiance et écart ;
- candidats écartés avec leur raison ;
- effet runtime.

## Tests

`tests/unit/contextual-target-identity.test.ts` :

- les TEST 1 à 11 de la demande ;
- matcher HARD / SOFT ;
- capture : id partagé, empreinte enrichie ;
- rétrocompatibilité.

`tests/integration/contextual-target-identity.test.ts` porte le cas réel, quatre `#valueInput` :

- **ancien comportement** : le mauvais champ est rempli, Playwright réussit, le parcours échoue
  plus loin ;
- **identité enrichie** : `CONTEXTUAL_MATCH`, seul le bon champ est rempli, le critère est
  appliqué, PASS ;
- **ancien enregistrement** : `TARGET_AMBIGUOUS`, rien n'est rempli ;
- **localisateur disparu** : `HEALED`, confirmé, connaissance candidate ;
- **healing dont l'effet échoue** : `ACTION_EFFECT_NOT_CONFIRMED`, rien n'est appris.

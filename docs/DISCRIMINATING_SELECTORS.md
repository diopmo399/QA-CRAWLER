# Sélecteurs discriminants : CSS + identité + contexte + unicité

> CSS IS NOT THE PROBLEM. AMBIGUOUS CSS IS THE PROBLEM. Le CSS est gardé ; il est rendu
> discriminant, vérifié sur l'écran courant, et l'identité sémantique confirme la cible.

## 0. Diagnostic (avant modification)

| Question                                  | Où                                                                                                                                            | Constat                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Où le CSS est capturé                  | `src/recording/capture-script.ts` — `cssOf` / `localCss`, appelés par `describe(el)` à chaque événement humain                                | Un seul CSS : data-testid, id non généré, `[name]`, `[formcontrolname]` **portés par l'élément lui-même**, sinon un chemin de positions (≤ 5 niveaux, `:nth-of-type`) arrêté sur la première balise de composant. `cssMatches` / `cssIndex` comptent les correspondances.                                                                                                                                                                                     |
| 2. Où il est normalisé                    | `src/recording/human-flow-recorder.ts` (`elementOf`, liste blanche), `src/recording/normalizer.ts` (`FieldMergeJudge`)                        | La liste blanche garde `css`, `cssStable`, `cssMatches`. La fusion des saisies passe par `FieldIdentity` (PR « FieldIdentity ») : jamais par le CSS seul, mais sans l'identité du **composant hôte**.                                                                                                                                                                                                                                                         |
| 3. Où le TargetFingerprint est créé       | `src/recording/recorded-target.ts` — `resolveRecordedTarget`                                                                                  | Candidats : libellé, rôle + nom, testId, `[name]`, `[formcontrolname]` (de l'élément), id stable, puis le CSS capturé. Le `formControlName` d'un ancêtre n'est jamais lu ; aucun CSS ancré sur l'hôte n'est proposé.                                                                                                                                                                                                                                          |
| 4. Où le YAML est généré                  | `src/recording/recorded-flow.ts` (`stepOf`)                                                                                                   | Le localisateur choisi + l'empreinte quand la cible est CSS / fragile / contextuelle. Ni CSS préféré, ni CSS structurel de repli, ni unicité à l'enregistrement.                                                                                                                                                                                                                                                                                              |
| 5. Où le localisateur est résolu au rejeu | `src/flows/flow-step-executor.ts` (`locate`), `src/explorer/flow-explorer.ts` (`runFlowElementStep`, `resolveFunctionalTarget`, `healTarget`) | Avec une empreinte : plusieurs correspondances → `TARGET_LOCATOR_NON_UNIQUE`, résolution fonctionnelle, sinon rien d'exécuté. **Sans empreinte** (ancien YAML `css:` seul) : `locate` prend la correspondance dans une fenêtre ouverte, sinon **la première** — un remplissage arbitraire. Le healing ne connaît pas de CSS préféré.                                                                                                                          |
| 6. Pourquoi deux champs ont le même CSS   | `localCss`                                                                                                                                    | Dans un composant maison (`<app-input-mask formcontrolname="x"><mat-form-field>…<input id="mat-input-0">`), l'input ne porte ni id stable (`mat-input-N` est généré), ni `name`, ni `formcontrolname` : seul le chemin de positions reste, et il est le même pour tous les champs construits par le même composant (`mat-form-field > div:nth-of-type(1) > div:nth-of-type(2) > div > input`). L'attribut qui les distingue est sur l'**ancêtre**, jamais lu. |

## 1. DISCRIMINATING CSS SELECTOR BUILDER (`src/recording/selector-builder.ts`)

Pour chaque élément, des candidats sont construits **puis comptés sur le DOM courant**
(`querySelectorAll`) ; un candidat qui ne désigne pas l'élément est écarté :

1. les attributs de l'élément : `data-testid` (et variantes), id **non généré**, `formcontrolname`,
   `name`, `aria-label`, `placeholder` ;
2. l'identité d'un **ancêtre** (jusqu'à 8 niveaux) : `formcontrolname` / `formgroupname` /
   `formarrayname` d'un composant hôte, `data-testid`, `name`, `data-field`, `data-section`, id stable
   — `app-input-mask[formcontrolname="branchNumber"] input` ; l'ancre la plus proche d'abord, arrêt au
   premier candidat unique (**minimum stable discriminating selector**, jamais le maximum) ;
3. deux niveaux de contexte (section marquée + hôte), seulement si rien n'est encore unique ;
4. la balise d'un composant maison, puis les classes stables (jamais les classes de framework ni
   générées) ;
5. le chemin **structurel** historique (`:nth-of-type`), toujours gardé en repli.

Chaque candidat : `selector`, `kind`, `matchCount`, `unique`, `stabilityScore`, `semanticScore`,
`specificityScore`, `usesDynamicAttribute`, `usesStructuralIndex`, `evidence`, `confidence`.
**UNIQUE ≠ BON** : la confiance combine stabilité, sémantique et concision, divise par deux un attribut
généré, pénalise un index structurel et écrase un candidat non unique. Le préféré est le meilleur
candidat unique.

**DynamicAttributeDetector** (`isDynamicValue`) : `mat-input-0`, `cdk-overlay-3`, `_ngcontent-*`,
`:r1:`, uuid, classes css-in-js, ids ou classes numérotés ; un attribut métier (`formControlName`,
`name`, `data-*`) n'est dynamique que s'il porte une longue suite de chiffres ou un hachage.

**Ambiguïté** (`ambiguityOf`) : `NONE` / `LOW` (repli générique, id généré) / `MEDIUM` (seul un chemin
structurel est unique) / `HIGH` (rien d'unique), avec ses raisons (`GENERIC_CSS`, `DYNAMIC_ID`,
`STRUCTURAL_ONLY`, `NO_UNIQUE_SELECTOR`, `REPEATED_LABEL`).

## 2. SCREEN ELEMENT INVENTORY (script de capture)

À l'arrivée d'un écran, d'une fenêtre, ou après un changement de **structure** (des contrôles apparus /
disparus : jamais une frappe), après un calme de 400 ms, les éléments interactifs visibles (≤ 150) sont
analysés et l'inventaire est envoyé (liaison dédiée, assainie côté Node : jamais une valeur saisie).
Chaque événement humain RÉUTILISE le descripteur de l'inventaire après une validation légère (le CSS
préféré désigne-t-il toujours cet élément, et lui seul ?) ; un élément absent de l'inventaire (apparu
dynamiquement) est analysé localement puis ajouté.

Artefacts : `screen-inventory.json` (descripteurs) et `screen-inventory.txt` :

```
SCREEN INVENTORY
----------------------------------------
Screen: Create request (SCREEN_ARRIVED, 5 ms)
Interactive elements: 5
Inputs: 4

INPUT-001
semantic: Branch number
preferred CSS: app-input-mask[formcontrolname="branchNumber"] input
matches: 1
status: UNIQUE (LOW: GENERIC_CSS, DYNAMIC_ID)
…
Generic selector:
mat-form-field > div > div > div > input
matches: 4
status: AMBIGUOUS
NOT SELECTED
```

## 3. Enregistrement : CSS préservé, enrichi, identité composite

- Le CSS propre de l'élément est **gardé** s'il est stable et unique ; sinon le CSS discriminant le
  remplace (qualité `FRAMEWORK_BINDING` pour un hôte lié). Un `formControlName` hérité d'un hôte ne
  produit jamais `[formcontrolname=x]` seul (il viserait l'hôte).
- L'empreinte porte : `formControl` (élément ou hôte), `host`, `maxLength`, `css.preferred` /
  `css.fallback` (sélecteur, correspondances à l'enregistrement, confiance), `ambiguity`. Le YAML garde
  l'empreinte de chaque champ dont le CSS est connu, même quand la cible principale est le libellé.
- `FieldIdentity` : l'identité de l'hôte (`app-input[formcontrolname="x"]`) ; deux champs qui partagent
  le même CSS structurel restent deux champs (la fusion des saisies compare l'identité, jamais le CSS).
- **DUPLICATE_TARGET_ACTION** : deux actions consécutives du même type sur la même identité, sans action
  entre elles, sont signalées (`TYPING_CONSOLIDATION_CANDIDATE`, `HUMAN_CORRECTION`, `REPEATED_ACTION`),
  jamais supprimées.

## 4. Rejeu

- **NEVER BLINDLY EXECUTE AN AMBIGUOUS LOCATOR** : un CSS qui désigne plusieurs éléments visibles (hors
  d'une fenêtre ouverte qui les départage) n'est jamais exécuté sur sa première correspondance. Avec une
  empreinte, la résolution existante (`TARGET_LOCATOR_NON_UNIQUE` → candidats + empreinte) départage ;
  sans elle (ancien YAML `css:` seul) : `AMBIGUOUS_TARGET: AMBIGUOUS_LOCATOR`, rien d'exécuté.
- **CSS REPLAY** : le CSS préféré enregistré est recompté sur le DOM actuel ; le rapport d'étape porte
  `cssResolution` (`CSS_CONFIRMED` : il désigne UN élément, celui utilisé ; `CSS_AMBIGUOUS` ;
  `CSS_CONFLICT` : il désigne un autre élément ; `CSS_NOT_FOUND`) et le repli structurel avec ses
  correspondances actuelles ; événements `LOCATOR_UNIQUE` / `LOCATOR_AMBIGUOUS`.
- **Empreinte** : `formControlName` (élément ou hôte) et `maxLength` sont lus au rejeu ; un autre
  `formControlName` est un écart HARD (jamais exécuté sur cet élément : ré-acquisition / healing / échec).
- **Healing** : le CSS préféré d'abord, puis l'identité sémantique (rôle + nom, test id, texte, libellé),
  puis le repli structurel — chacun seulement s'il désigne UN élément confirmé par l'empreinte.
- **Perte de valeur** (`classifyValueLoss`, sur le TARGET RÉEL) : `WRONG_TARGET`, `FIELD_DISAPPEARED`,
  `FIELD_RERENDERED`, `VALIDATION_REJECTED`, `VALUE_CLEARED`, `VALUE_REJECTED_BY_APPLICATION`,
  `VALUE_REPLACED`, `UNKNOWN_VALUE_LOSS`.

## 5. Observabilité

Enregistrement : `SCREEN_INVENTORY_COMPLETED`, `TARGET_MATCHED_FROM_INVENTORY`,
`TARGET_INVENTORY_MISS`, `CSS_CANDIDATE_SELECTED`, `LOCATOR_AMBIGUOUS`,
`DUPLICATE_TARGET_ACTION_DETECTED`. Rejeu : `LOCATOR_UNIQUE`, `LOCATOR_AMBIGUOUS`,
`TARGET_LOCATOR_NON_UNIQUE`, `TARGET_HEALED`, `REPLAY_FIELD_TARGET_CONFIRMED`.

## 6. Performance

Un inventaire par écran (≤ 150 éléments, ~5 ms sur l'écran de test), jamais par frappe ; un descripteur
réutilisé coûte un seul `querySelectorAll` de validation ; au plus 16 candidats comptés par élément.

## 7. Compatibilité

Les anciens YAML (`css:` seul, empreinte sans `css`) restent valides. Un ancien CSS ambigu n'est plus
exécuté sur sa première correspondance : l'étape échoue avec `AMBIGUOUS_TARGET` (plutôt qu'un choix
arbitraire) ; réenregistrer le parcours ajoute le CSS discriminant et l'empreinte.

## 8. Limites

- Un shadow DOM : l'analyse discriminante n'y est pas faite (le CSS y reste préfixé par l'hôte, comme
  avant).
- Le rejeu n'utilise pas encore un inventaire complet de l'écran courant : il recompte les CSS
  enregistrés de la cible et s'appuie sur la résolution fonctionnelle existante pour départager.
- Aucun appel à l'IA dans ce chemin ; une ambiguïté restante (`AMBIGUOUS_TARGET`) est le point d'entrée
  prévu pour un conseiller, dont la proposition passerait par la résolution, la validation des preuves
  et la SafetyPolicy.

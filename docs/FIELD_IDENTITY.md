# Identité fonctionnelle d'un champ (FieldIdentity)

> SAME CSS ≠ SAME FIELD. PRESERVE FIRST, MERGE ONLY WITH STRONG EVIDENCE.

## Diagnostic : pourquoi h013, h015 et h017 ont été fusionnés dans h019

Les artefacts du cas réel ne sont pas dans le dépôt (`.qa-crawler/` reste local). La chaîne
ci-dessous est reconstruite à partir du code, puis reproduite à l'identique par
`tests/integration/field-identity.test.ts` : trois `mat-form-field` dont les `input` n'ont ni
libellé relié, ni `name`, ni `formControlName`, ni id stable.

### 1. RAW EVENT → target

`capture-script.ts`, `localCss()` : sans test id, id stable, `name` ou `formcontrolname`, le CSS
est un chemin de positions qui **s'arrête au premier composant à tiret** (« ancre plus stable
qu'une position ») :

```
mat-form-field > div:nth-of-type(1) > div:nth-of-type(2) > div > input
```

Ce chemin est **relatif** au `mat-form-field`. Les trois champs ont la même structure interne :
ils produisent **le même CSS**, et `document.querySelectorAll(css)` renvoie 3 éléments
(`pre.cssCount = 3`). Personne ne le lit.

`recorded-target.ts`, `resolveRecordedTarget()` : sans libellé, nom accessible ni attribut stable,
le seul candidat est ce CSS. Il est déclaré `unique: true` **sans vérification**. La cible
enregistrée est donc `{ strategy: 'css', value: 'mat-form-field > … > input' }` pour les trois
champs. Le texte du `mat-label` est bien capturé (`element.formField`) et la position aussi
(`nearbyText`, `inputType`), mais seulement dans l'empreinte, jamais dans l'identité.

### 2. Les événements bruts

| id   | événement                                   | sémantique                |
| ---- | ------------------------------------------- | ------------------------- |
| h013 | `input` dans A (`12345`, 5 caractères)      | FILL                      |
| h014 | `click` dans B : « focus click in a field » | **bruit** : aucune action |
| h015 | `input` dans B (`alpha`)                    | FILL                      |
| h016 | `click` dans C : « focus click in a field » | **bruit** : aucune action |
| h017 | `input` dans C                              | FILL                      |
| h019 | `change` (validation du champ au départ)    | FILL                      |

Le clic qui fait passer le focus d'un champ à l'autre est un **bruit** (`semantic-recording.ts`,
`noise += 1`). Il ne crée aucune action et **ne sépare donc pas** les saisies : pour le
normaliseur, les FILL de A, B et C sont **consécutifs**.

### 3. fieldKey → décision de fusion

`normalizer.ts` :

```ts
function fieldKey(action) {
  return action.target ? JSON.stringify(action.target.target) : action.id;
}
// 2. Saisies successives d'un même champ
fieldKey(previous) === fieldKey(action) && !protectedAction(previous)  →  previous.dropped = 'merged into the next input of the same field'
```

`fieldKey` = **le localisateur sérialisé**. Les trois CSS sont identiques, donc les trois clés le
sont aussi. Chaque FILL est fusionné dans le suivant : h013 → h015 → h017 → h019. Seule la
**dernière** valeur survit. L'étape 4 (corrections, même `fieldKey` jusqu'au prochain envoi)
aurait produit la même fusion même avec une action entre les deux.

Aucun signal n'a été consulté : ni l'instance DOM (trois éléments différents), ni le `mat-label`,
ni le profil (5 caractères numériques ou texte libre), ni l'unicité du CSS (3 correspondances),
ni le changement de focus (h014, h016).

### 4. action sémantique → TestData → FILL généré

- `action-preservation.json` : h013, h015 et h017 sont `MERGED` (règle `TYPING_MERGED`) dans h019.
- `recorded-test-data.ts`, `resolveTestDataKey()` : pas de `formControlName`, `name`, test id,
  id stable ni libellé relié, donc la clé de repli est **`value`**. Le texte du `mat-label`
  (`formField`) et le `placeholder` ne sont pas lus.
- Le flow généré contient **un seul** `fill: { css: mat-form-field > … > input }` =
  `${testData:value}`, avec la valeur de C.

### 5. Replay

Le CSS désigne trois éléments. Avant #84, le premier (A, numérique, `maxlength=5`) reçoit la valeur
de C : la valeur lue n'est pas celle injectée, d'où `ACTION_EFFECT_NOT_CONFIRMED` / `WRONG_EFFECT`
(`expected VALUE_CHANGED`). Même avec la résolution contextuelle de #84, deux saisies humaines
sont **perdues** à l'enregistrement : aucun rejeu ne peut les retrouver.

**La ligne fautive** : `normalizer.ts`, `fieldKey()` (identité = localisateur), aggravée par
`resolveRecordedTarget()`, qui déclare unique un CSS non vérifié, et par le clic de focus traité
comme du bruit, qui efface la frontière entre les champs.

## Correction

```
DOM Element → TargetFingerprint (capture) → FieldIdentity → FieldIdentityMatcher → normalizer (TypingMergeDecision)
```

1. **Capture.**
   - `domInstance` : un identifiant d'instance attribué par l'enregistreur (`e42`), jamais un
     localisateur de rejeu.
   - `maxLength`, `inputMode`, `pattern`.
   - `activeDomInstance` : l'élément actif au moment de `input` / `change`.
   - `cssMatches` / `cssIndex` : combien d'éléments le CSS désigne, et la position de l'élément
     réel parmi eux. À défaut, l'unicité est lue dans `pre.cssCount`.
   - **Défaut corrigé au passage.** `human-flow-recorder.ts` ne garde de la description de l'élément que
     les champs d'une liste blanche. `formField`, `nearbyText` et `sameId` (ajoutés par la capture en #84) y
     manquaient : l'empreinte contextualisée n'atteignait jamais les artefacts d'un vrai
     enregistrement. Ces champs y sont ajoutés, avec ceux de FieldIdentity, et les textes sont
     expurgés comme les autres.
2. **FieldIdentity** (`src/recording/field-identity.ts`).
   - Elle est construite à partir de la même description que l'empreinte, sans système parallèle.
   - `fieldIdentityKey()` (fieldKey V2) suit cet ordre : `formControlName` → test id → `name` →
     id stable **unique** → libellé → `mat-label` → `placeholder` → concept, chacun dans son
     contexte (dialogue, section). Un CSS seul ne fait une clé que s'il est démontré unique ;
     sinon c'est l'instance DOM, ou l'action elle-même (jamais partagée).
3. **FieldIdentityMatcher** : `EXACT_SAME_FIELD` / `STRONG_SAME_FIELD` / `AMBIGUOUS_FIELD` /
   `DIFFERENT_FIELD`, avec une confiance `{ score, reasons }`.
   - Les contradictions sont décisives : un autre libellé, `formControlName`, dialogue, section ou
     type ; un profil incompatible (`maxlength`, `inputmode`, numérique ou texte) ; une autre
     instance DOM sans preuve forte de re-rendu.
   - Un CSS générique seul vaut au mieux `AMBIGUOUS_FIELD`.
4. **TypingMergeDecision** : une décision `MERGE` / `KEEP_SEPARATE` / `AMBIGUOUS_KEEP_SEPARATE`
   pour chaque paire, avec ses raisons. Seuls `EXACT_SAME_FIELD` et `STRONG_SAME_FIELD` fusionnent.
   - Un clic de focus dans **un autre** champ entre deux saisies est une frontière forte
     (`FOCUS_CHANGED_TO_DIFFERENT_FIELD`).
   - Les corrections (étape 4) suivent la même règle.
   - Les décisions sont écrites dans `typing-merge-decisions.json`, et les événements
     `TYPING_MERGE_EVALUATED` / `ACCEPTED` / `REJECTED` sont émis.
5. **TestData.**
   - Après le libellé relié, la clé est prise dans le `mat-label` (`formField`), puis dans le
     `placeholder`.
   - Deux champs **différents** qui obtiennent la même clé ne la partagent jamais : ils sont
     départagés par leur section, ou reçoivent `field_<empreinte>`. Les événements
     `TESTDATA_FIELD_CONFLICT` et `TESTDATA_FIELD_BOUND` sont émis.
   - Le même champ ressaisi garde `initial` / `updated`.
6. **Cible générée.** Un CSS qui désigne plusieurs éléments n'est plus déclaré unique (raison
   `GENERIC_LOCATOR_DETECTED`).
   - Si l'empreinte distingue le champ (`mat-label`, placeholder, libellé, dialogue), c'est elle qui
     départage les candidats au rejeu (#84).
   - Sinon, la cible reçoit la **position enregistrée** de l'élément que l'humain a réellement
     utilisé (`nth` = `cssIndex`). C'est le dernier recours, signalé comme tel ; ce n'est jamais un
     « premier » arbitraire.
   - Sans position connue, la cible est déclarée ambiguë.
7. **Validation de l'enregistrement.** `INVALID_FIELD_MERGE` signale une fusion entre deux
   instances DOM, deux libellés, deux profils ou deux contextes différents.
   `POSSIBLY_INVALID_FIELD_MERGE` signale un ancien enregistrement : CSS générique, clé `value` et
   plusieurs saisies humaines. Les fichiers ne sont jamais réécrits.
8. **Rejeu : jamais le premier élément.** Un localisateur qui désigne plusieurs éléments, sans
   aucun candidat qui porte l'identité enregistrée, n'est plus confié au « chemin strict ». Ce
   chemin agissait en pratique sur la première correspondance : un ancien FILL fusionné écrivait
   la valeur de C dans A.
   - Un healing par l'empreinte peut encore désigner la cible.
   - Sinon : `TARGET_LOCATOR_NON_UNIQUE … no candidate carries the recorded identity (nothing
chosen arbitrarily, not executed) — FIELD_LOCATOR_NON_UNIQUE`.
   - L'ambiguïté entre candidats plausibles est suffixée par `FIELD_IDENTITY_AMBIGUOUS` pour un
     FILL.
9. **Rejeu après un FILL.** Avant de comparer la valeur, l'identité de l'élément rempli est
   vérifiée.
   - `FIELD_TARGET_MISMATCH` : ce n'est pas le champ enregistré, même si sa valeur a changé.
   - `FIELD_VALUE_MISMATCH` : c'est le bon champ, mais la valeur n'est pas tenue.
   - Les deux causes ne se mélangent plus. Événements : `REPLAY_FIELD_TARGET_CONFIRMED` /
     `REPLAY_FIELD_TARGET_MISMATCH` / `REPLAY_FIELD_VALUE_CONFIRMED` / `REPLAY_FIELD_VALUE_MISMATCH`.

## Preuve de bout en bout (`tests/integration/field-identity.test.ts`)

Le formulaire contient trois `mat-form-field`, chacun dans sa ligne, sans libellé lisible.
L'humain saisit `12345` dans A, `alpha` dans B, puis un nom d'entreprise dans C.

| Étape                          | Ce qui est vérifié                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| raw recording                  | 3 instances DOM (`e1`, `e2`, `e4`), un **seul** CSS `mat-form-field > div > div:nth-of-type(2) > div > input`, `cssMatches = 3`                     |
| semantic recording             | 3 FILL ; chaque paire entre champs est `KEEP_SEPARATE` (`FOCUS_CHANGED_TO_DIFFERENT_FIELD`, `different DOM instance`, `incompatible value profile`) |
| action-preservation            | chaque saisie est `PRESERVED` ; une fusion n'a lieu qu'à l'intérieur d'un champ (`EXACT_SAME_FIELD`)                                                |
| generated flow                 | 3 FILL, même CSS, positions enregistrées `nth` 0 / 1 / 2 ; avec `mat-label` : `label: Employee number`…                                             |
| test-data                      | 3 clés distinctes (`request.employeeNumber`, `request.employeeName`, `request.companyName`), jamais `value`                                         |
| replay target et valeur réelle | le serveur reçoit `employeeNumber = 12345`, `employeeName = alpha`, et `companyName` est la valeur de C ; 3 × `REPLAY_FIELD_VALUE_CONFIRMED`        |
| ancien flow fusionné           | `TARGET_LOCATOR_NON_UNIQUE … FIELD_LOCATOR_NON_UNIQUE` : rien n'est saisi, rien n'est envoyé                                                        |

Les tests unitaires (`tests/unit/field-identity.test.ts`) couvrent TEST 1 à 13 et rejouent la
trace exacte h013 → h019.

# Assertions issues du recording, groupes métier et génération multi-format

Ce document décrit ce que QA-CRAWLER fait d'un enregistrement une fois « Arrêter » pressé : les
observations qu'il en tire, les assertions qu'il propose, la décision humaine, les groupes métier,
puis la génération des tests (flow YAML, Gherkin, Playwright TypeScript, Java JUnit 5 + Playwright
Java) et ce que chaque statut veut dire. Le moteur ne dépend d'aucun LLM ; l'assistant IA, s'il est
activé ailleurs, n'entre pas dans cette chaîne.

Règle fondamentale : **le recording est une source d'observations, pas une preuve de toutes les règles
métier.** Chaque assertion a une origine identifiable et une confiance explicite ; rien n'entre dans le
flow sans décision humaine, sauf les vérifications stables que le recorder retenait déjà (et que
l'humain peut retirer).

## 1. Les observations (`observations.json`)

À l'arrêt, chaque action gardée produit ses observations : des faits identifiés (`ob1`, `ob2`…), reliés à
l'action (`actionId`) et à l'étape du flow (`stepId`), datés, avec une source et une fiabilité.

| Source                                 | Observations                                                                                                          | Fiabilité   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| `ACCESSIBILITY` / `DOM`                | élément touché (rôle, nom), écran (route, titre), messages, dialogues, contrôles apparus / disparus, état coché       | 0.85 / 0.95 |
| `USER_INPUT`                           | la saisie, par sa **classe** seulement (donnée de test, littéral métier, secret masqué), jamais la valeur sensible    | 0.8         |
| `NAVIGATION`                           | la navigation causée par l'action                                                                                     | 0.95        |
| `NETWORK_REQUEST` / `NETWORK_RESPONSE` | requête (méthode, chemin, champs), réponse (statut, code d'erreur, état métier), identifiants, enregistrements servis | 0.95        |
| `EXPLICIT_REQUIREMENT`                 | un point de contrôle posé par l'humain                                                                                | 0.8         |

Ce qui n'a pas été capturé est listé comme **absent** (`missing` : écran non observé après une action,
requête sans réponse, écriture sans réseau) et ce que le recorder ne capture pas est dit
(`notCaptured: ["CONSOLE", "API_CONTRACT"]`). Rien n'est reconstitué.

## 2. Les propositions d'assertions (`assertion-proposals.json`)

Chaque proposition dit **ce qu'elle vérifie, pourquoi, d'après quelles observations et preuves, par
quelle méthode, avec quelles limites et quelle confiance**, et si une confirmation humaine est requise.

| Origine    | Sens                                                                    | Exemples                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OBSERVED` | tirée d'une observation concrète                                        | la page `/items` est affichée ; `POST /api/items` est acceptée ; aucune erreur après l'écriture ; la saisie « Title » se retrouve dans la requête quand l'analyse HTTP l'a vue |
| `DEDUCED`  | d'une relation plausible entre plusieurs observations — **à confirmer** | la valeur saisie est dans le corps de l'écriture acceptée (champ non identifié) ; la lecture suivante sert l'enregistrement créé ; un état métier lu dans la réponse           |
| `EXPLICIT` | posée par l'humain                                                      | un point de contrôle                                                                                                                                                           |

Deux méthodes de vérification, toutes deux exécutées par le rejeu existant :

- `UI_EXPECT` : une étape `expect` du flow (url, text, visible, response, noError) ;
- `BUSINESS_ASSERTION` : une assertion métier du schéma de la mission (`assertions:`,
  [BUSINESS_ASSERTIONS.md](BUSINESS_ASSERTIONS.md)), vérifiée par le `BusinessAssertionEngine` sur le
  réseau observé au rejeu — jamais la base de données.

Une proposition `REPORT_ONLY` n'est pas exécutable (reportée, jamais vérifiée). Les propositions
redondantes sont fusionnées ; deux propositions contradictoires (la même requête acceptée et refusée)
se signalent l'une l'autre (`conflictsWith`). Une déduction ne devient **jamais** une règle métier sans
décision humaine.

### La décision humaine

Dans la fenêtre du recorder (revue, sous les vérifications), chaque proposition montre son origine, sa
catégorie, sa méthode, sa confiance, ses preuves (`obN`), ses limites, et les boutons **Accepter**,
**Refuser**, **Désactiver**, **Réinitialiser**. La décision réécrit le flow :

| Statut                  | Effet                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `PROPOSED`              | aucune décision : le flow est celui d'avant (candidat stable retenu, sinon hors du flow) |
| `APPROVED` / `MODIFIED` | une étape `expect` (provenance `HUMAN_DECISION`) ou une entrée `assertions:` du YAML     |
| `REJECTED` / `DISABLED` | retirée du flow (aussi quand elle y était par défaut)                                    |

En API : `decideProposal(flow, { id, decision: 'ACCEPT' | 'REJECT' | 'DISABLE' | 'RESET' | 'MODIFY', description?, mandatory?, criticality?, note? })`.

## 3. Les groupes métier (`recorded-flow.json` › `groups`, YAML › `groups:`)

Un groupe (« Création de la demande ») est un **objet fonctionnel** : un identifiant stable, un nom, une
description, des étapes existantes dans l'ordre du flow. Dans la fenêtre (mode **Modifier**) : cocher des
étapes, **créer un groupe**, les **ajouter** à un groupe, renommer, replier / déplier, monter / descendre
un groupe ou une étape, détacher, supprimer le groupe (les étapes restent).

Les identifiants des étapes ne changent jamais ; une vérification suit toujours l'action qu'elle vérifie
(elle se déplace avec elle). Avant tout déplacement, les **dépendances de données** sont vérifiées
(lignage `{ testData }` et citations `${testData:…}`) : un ordre qui citerait une valeur avant l'étape
qui la produit est **bloqué** et expliqué (`force` le passe outre, en avertissement). Chaque groupe
expose ses **entrées** (données produites ailleurs), ses **sorties**, son point de départ, ses
vérifications et assertions, et s'il est **jouable seul** (sinon ce qui manque).

Dans le YAML : `groups: [{ id, name, description?, steps: [positions 1…n] }]` (informatif pour le rejeu,
structurant pour la génération). Un ancien enregistrement sans groupe reste valide.

## 4. La génération (`generation.json`, `generated/`)

Dans la fenêtre (revue, section **Génération des tests**) : choisir les formats, les groupes (tous par
défaut), puis **Générer et valider**. Chaque fichier est écrit sous `recordings/<nom>/generated/` et
reçoit un statut qui ne confond jamais génération, validation statique et exécution réelle :

| Statut                                                        | Sens                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GENERATED`                                                   | écrit                                                                                                                                                                                                               |
| `STATICALLY_VALIDATED`                                        | relu par un outil réel : schéma du flow (YAML), dictionnaire Gherkin (chaque phrase a une définition), TypeScript (syntaxe seule, sans les types de `@playwright/test`), `mvn test-compile` (Java, si Maven est là) |
| `NOT_VALIDATED`                                               | aucun outil disponible ici — dit, jamais caché                                                                                                                                                                      |
| `EXECUTED` / `PASSED` / `FAILED` / `BLOCKED` / `INCONCLUSIVE` | seulement d'après une exécution réelle (rejeu QA-CRAWLER du flow YAML, `mvn test`)                                                                                                                                  |

Les assertions suivent la même règle : `APPROVED` / `MODIFIED` (décision), puis le statut de leur dernière
exécution ; jamais un succès par défaut.

### Une seule traduction des assertions

Les trois générateurs lisent le même modèle (`assertions:` du flow) à travers
`src/platform/assertion-translation.ts` :

- **NATIVE** — ce qu'un test autonome vérifie sur l'écran (`value` / `entity` / `state` avec `source: ui`)
  devient une attente : `expect(page.getByText(…)).toBeVisible()` en TypeScript, `assertThat(…).isVisible()`
  en Java, « Alors je vois … » en Gherkin ;
- **REPLAY_ONLY** — ce qui exige le réseau observé, une API relue ou le contrat OpenAPI est **dit** en
  commentaire dans le test et dans l'en-tête de la classe (« verified by the QA-CRAWLER replay only »),
  jamais omis, jamais compté comme un succès ; le flow YAML les porte, le rejeu les vérifie.

Les groupes deviennent des en-têtes (`// ── group: …`, `# ── group: …`) : jamais des tests indépendants
quand ils dépendent de données produites avant eux.

### En ligne de commande (flows de la mission)

```bash
npx qa-crawler generate-tests             # Playwright TypeScript (qa-crawler/generated-tests/)
npx qa-crawler generate-tests --gherkin   # scénarios .feature (qa-crawler/generated-features/)
npx qa-crawler generate-tests --java      # projet Maven JUnit 5 + Playwright Java (qa-crawler/generated-tests-java/)
npx qa-crawler replay                     # le rejeu QA-CRAWLER : exécute les assertions métier (réseau observé), écrit les preuves
npx qa-crawler replay --junit             # + junit.xml : un cas par étape ET par assertion métier exécutée
```

Les flows sauvés depuis un enregistrement portent `assertions:` et `groups:` : les générateurs les
reprennent tels quels. Détails Java : [JAVA_TEST_GENERATION.md](JAVA_TEST_GENERATION.md).

## 5. JUnit XML : un rapport, pas un langage de test

`reports/junit.xml` représente les **résultats réels** du rejeu : une suite par flow, un cas par étape, et
un cas par assertion métier exécutée (`PASS` → réussi, `FAIL` → `failure`, `BLOCKED` / `INCONCLUSIVE` /
`UNVERIFIABLE` → `skipped` avec le motif, le format ne sachant pas dire « non concluant » ; le détail
reste dans `result.json` et `index.html`). Un test seulement généré n'y figure jamais.

## 6. Traçabilité

Les assertions acceptées sont des assertions de la mission : la traçabilité de
[BUSINESS_ASSERTIONS.md](BUSINESS_ASSERTIONS.md) (exigences ↔ règles ↔ flows ↔ assertions ↔ preuves,
statuts `NOT_COVERED`, `COVERED_NOT_EXECUTED`, `VERIFIED_PASS`, `VERIFIED_FAIL`, `BLOCKED`,
`INCONCLUSIVE`, `STALE_EVIDENCE`) s'applique sans rien de plus ; `flow.requirements` relie un flow
enregistré à ses exigences.

## 7. Fichiers

| Fichier                                          | Contenu                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `recordings/<nom>/observations.json`             | les observations (résumé par source, liste, absences, non capturé) |
| `recordings/<nom>/assertion-proposals.json`      | les propositions, leurs décisions, les assertions métier acceptées |
| `recordings/<nom>/recorded-flow.json`            | le flow, avec `proposals`, `businessAssertions`, `groups`          |
| `recordings/<nom>/generated.flow.yaml`           | le YAML (avec `assertions:` et `groups:` quand il y en a)          |
| `recordings/<nom>/generation.json`, `generated/` | la dernière génération et ses fichiers                             |

## 8. Limites

- Une proposition `DEDUCED` sans champ identifié vérifie « une valeur du corps de la requête » : la
  confirmer, puis préciser `field:` dans le YAML si le nom de la propriété est connu.
- La console du navigateur et le contrat OpenAPI ne sont pas observés à l'enregistrement.
- La validation TypeScript est syntaxique (les types de `@playwright/test` ne sont pas résolus ici) ; la
  validation Java exige Maven et le réseau (Maven Central) ou un dépôt local.
- Un test généré qui passe prouve ce que ses actions et attentes couvrent sur l'application où il a
  tourné, rien de plus ; les assertions `REPLAY_ONLY` ne sont vérifiées que par le rejeu QA-CRAWLER.

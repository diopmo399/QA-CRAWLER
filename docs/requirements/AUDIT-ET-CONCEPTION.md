# Exigences : importation, corrélation et traçabilité — audit et conception

Ce document ouvre le chantier « référentiel d'exigences » : il dit ce qui existe, ce qui manque,
l'architecture retenue, les décisions et le plan. Une capacité n'est `EXISTANT_ET_TESTÉ` que si un
module la réalise **et** qu'un test nommé l'exerce.

| État                      | Sens                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `EXISTANT_ET_TESTÉ`       | réalisé, couvert par un test qui passe                          |
| `EXISTANT_MAIS_INCOMPLET` | réalisé en partie ; l'écart est dit                             |
| `EXISTANT_NON_VÉRIFIÉ`    | du code existe, aucun test ne prouve le comportement            |
| `ABSENT`                  | aucun code                                                      |
| `À_CLARIFIER`             | une décision ou une information est attendue (questions en § 6) |

## 1. État du dépôt au départ

- Branche de travail `feat/requirements-foundation`, créée depuis `feat/sdk-dashboard`. Elle est empilée sur
  les PR #141, #142 et #143, vertes et non fusionnées. L'arbre de travail était propre : aucune
  modification locale, aucun fichier non suivi.
- Langage : TypeScript strict (ESM), Node 20+.
- Dépendances d'exécution : `@cucumber/gherkin`, `playwright`, `yaml`, `zod`. Aucune bibliothèque
  Word, PDF, Excel ou Confluence.
- Tests : Vitest (`unit`, `integration`, `packaging`). Persistance testée sur fichier, mémoire,
  SQLite, PostgreSQL et SQL Server (job `persistence` de la CI).

## 2. Inventaire

### 2.1 Sources d'exigences

| Capacité                                              | État                | Preuve / écart                                                         |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| Exigences et règles déclarées dans la mission (YAML)  | `EXISTANT_ET_TESTÉ` | `requirementSchema`, `businessRuleSchema` ; `traceability.test.ts`     |
| Exigences par tags Gherkin (`@REQ-12`)                | `EXISTANT_ET_TESTÉ` | `requirementTagsOf` ; `gherkin.test.ts`                                |
| Exigences par OpenAPI (`x-requirements`)              | `EXISTANT_ET_TESTÉ` | `oracles/api-contract.ts` ; `traceability.test.ts`                     |
| Importation Confluence                                | `ABSENT`            |                                                                        |
| Importation Word                                      | `ABSENT`            |                                                                        |
| Importation PDF                                       | `ABSENT`            |                                                                        |
| Importation Excel                                     | `ABSENT`            |                                                                        |
| Référentiel d'exigences versionné, validation humaine | `ABSENT`            | les exigences n'existent que dans la mission, sans version ni décision |
| Critères d'acceptation                                | `ABSENT`            |                                                                        |

### 2.2 Traçabilité et vérification

| Capacité                                                                                        | État                | Preuve / écart                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Exigence → règle → flow → assertion → résultat → preuve, par run                                | `EXISTANT_ET_TESTÉ` | `quality/traceability.ts`, `business-verification.test.ts` (moteur réel) |
| Statuts de vérification (PASS, FAIL, non exécuté, bloqué, non concluant, périmé)                | `EXISTANT_ET_TESTÉ` | `COVERAGE_STATUSES` ; historique `traceability-history.json`             |
| Liens typés avec origine (`COVERS`, `VERIFIES`, `DEPENDS_ON`, `CONFLICTS_WITH`, `DERIVED_FROM`) | `EXISTANT_ET_TESTÉ` | calculés à chaque run, non persistés, sans confiance ni décision humaine |
| Assertions métier (valeur observée contre valeur attendue)                                      | `EXISTANT_ET_TESTÉ` | `assertion-engine.ts` ; un clic réussi n'est jamais un résultat métier   |
| Liens persistés avec confiance, validation, historique, fraîcheur                               | `ABSENT`            |                                                                          |
| Vue SDK de la traçabilité d'un run                                                              | `EXISTANT_ET_TESTÉ` | `reports.traceability`, `sdk-runs.test.ts`                               |

### 2.3 Analyse du code

| Capacité                                                                            | État                      | Preuve / écart                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Dépôt Git en lecture seule (clone, branche, commit)                                 | `EXISTANT_ET_TESTÉ`       | `static-analysis/sources/git-source.ts`, `git-source.test.ts`, `static-git-source.test.ts` |
| TypeScript / JavaScript, Angular (routes, formulaires, champs, règles, appels HTTP) | `EXISTANT_ET_TESTÉ`       | `static-analysis/*` (compilateur TypeScript)                                               |
| React, Vue                                                                          | `EXISTANT_MAIS_INCOMPLET` | `StaticFramework` les nomme ; l'analyse dédiée reste générique                             |
| Java, Spring Boot, SQL                                                              | `ABSENT`                  | le générateur Java **produit** des tests ; aucun analyseur ne **lit** du Java              |
| OpenAPI (opérations, `x-requirements`)                                              | `EXISTANT_ET_TESTÉ`       | `api-contract.ts`                                                                          |
| Tests Playwright, Gherkin, scénarios QA-CRAWLER                                     | `EXISTANT_ET_TESTÉ`       | lus par le moteur (flows, `.feature`) ; les tests Playwright tiers ne sont pas lus         |

### 2.4 Persistance, interfaces, sécurité

| Capacité                                                                  | État                     | Preuve / écart                                                                   |
| ------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Fournisseurs du moteur (fichier, mémoire, SQLite, PostgreSQL, SQL Server) | `EXISTANT_ET_TESTÉ`      | `persistence-*.test.ts` ; ils stockent la mémoire des runs, pas des référentiels |
| Fichiers du SDK par projet (JSON, écriture atomique)                      | `EXISTANT_ET_TESTÉ`      | environnements, scénarios (`sdk-platform.test.ts`)                               |
| SDK, CLI de la plateforme, Dashboard                                      | `EXISTANT_ET_TESTÉ`      | PR #141 à #143                                                                   |
| Secrets par nom de variable `QA_*`, jamais renvoyés                       | `EXISTANT_ET_TESTÉ`      | environnements du SDK                                                            |
| Masquage des secrets dans les journaux, assainissement pour l'IA          | `EXISTANT_ET_TESTÉ`      | `security/redactor.ts`, `ai/sanitizer.ts`                                        |
| Identité des utilisateurs, rôles                                          | `ABSENT` · `À_CLARIFIER` | un jeton par service (Q1 de `docs/sdk/MASTER-PLAN.md`)                           |

## 3. Architecture retenue

```
 Connecteurs (accès + extraction)            Pipeline commun                     Référentiel canonique
 ┌──────────────┐                     ┌───────────────────────────┐         ┌──────────────────────────┐
 │ Confluence   │──┐                  │ validation (format, taille)│        │ Requirement, BusinessRule │
 │ Word (.docx) │──┤  ExtractedDocument│ normalisation → candidats  │ publier│ AcceptanceCriterion       │
 │ Excel (.xlsx)│──┼──(blocs + lieux)─▶│ doublons, conflits         │──────▶│ SourceReference (toutes)   │
 │ PDF          │──┘                  │ lot d'importation          │ (décisions humaines) │ TraceabilityLink │
 └──────────────┘                     │ VALIDATION_REQUIRED        │         │ historique, versions      │
                                      └───────────────────────────┘         └────────────┬─────────────┘
                                                                                          │
                     Moteur de corrélation (phase 5) : identifiants explicites, Gherkin, │
                     OpenAPI, analyse statique existante, traçabilité des runs  ◀───────┘
```

Responsabilités séparées, une par module de `src/requirements/` :

| Module           | Rôle                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| `model.ts`       | le modèle canonique et ses statuts (types et schémas zod de persistance)                |
| `connector.ts`   | le contrat d'un connecteur : identification, validation, extraction, capacités, limites |
| `document.ts`    | le document extrait commun : blocs (titre, paragraphe, liste, tableau) et leur lieu     |
| `classify.ts`    | la normalisation : blocs → éléments candidats, avec type, confiance et raisons          |
| `fingerprint.ts` | empreintes et similarité (doublons)                                                     |
| `repository.ts`  | la persistance du référentiel et des lots (fichiers JSON du projet, écriture atomique)  |
| `pipeline.ts`    | l'importation, la vérification des doublons, les décisions, la publication              |
| `connectors/*`   | un adaptateur par source ; aucun ne classe ni ne corrèle                                |

Les connecteurs ne font qu'**accéder** et **extraire**. La classification, les doublons, la
persistance, la corrélation et la présentation sont communes : un nouveau connecteur ne touche ni au
modèle ni au moteur.

## 4. Décisions

### D1 — Persistance du référentiel : fichiers JSON du projet

- **Option A, retenue.** Fichiers du projet (`<projet>/requirements/`), écriture atomique, comme les
  environnements du SDK. Les avantages :
  - aucun schéma ni migration ;
  - lisible et versionnable dans Git ;
  - les mêmes règles valent pour le SDK, la CLI et le Dashboard.

  Limite : un seul service écrit à la fois (risque R2 de `docs/sdk/MASTER-PLAN.md`).

- **Option B.** Les fournisseurs du moteur (SQLite, PostgreSQL, SQL Server). Cela demande de
  nouveaux dépôts et migrations sur cinq fournisseurs. Cette option est reportée, à reprendre si
  plusieurs services doivent écrire le même référentiel.

### D2 — Word et Excel : lecture du format Office Open XML sans dépendance

Un `.docx` et un `.xlsx` sont des archives ZIP de XML.

- **Option A, retenue.** Un lecteur ZIP minimal (`node:zlib`, limites de taille et de décompression)
  et un lecteur XML restreint, écrits pour ces deux formats. Les avantages :
  - aucune dépendance ;
  - provenance exacte (paragraphe, style de titre, feuille, cellule) ;
  - limites maîtrisées contre les bombes de décompression.

  Ce qui n'est pas lu (fichiers chiffrés, objets intégrés, formules non calculées) produit un
  avertissement.

- **Option B.** `mammoth` et `exceljs` : des dépendances lourdes, qui perdent une partie de la
  provenance (cellules).

### D3 — PDF : décision reportée à la phase 4 (`À_CLARIFIER`, Q4)

Extraire le texte d'un PDF de façon fiable demande une bibliothèque : polices, encodages, flux
compressés.

- **Option A.** `pdfjs-dist`, sous licence Apache-2.0 : une dépendance de plusieurs mégaoctets.
- **Option B.** Pas de PDF.

Un analyseur maison serait peu fiable : écarté. L'OCR suppose un moteur externe (Tesseract). Il est
`ABSENT` : une page sans texte est signalée, jamais inventée.

### D4 — Confluence : API REST officielles, Cloud et Data Center

| Variante    | Lecture d'une page                                             | Authentification                 |
| ----------- | -------------------------------------------------------------- | -------------------------------- |
| Cloud       | `GET /wiki/api/v2/pages/{id}?body-format=storage`              | courriel + jeton d'API (Basic)   |
| Data Center | `GET /rest/api/content/{id}?expand=body.storage,version,space` | jeton d'accès personnel (Bearer) |

Le corps est lu au format « storage » (XHTML), puis converti en blocs. Les identifiants sont lus
dans des variables d'environnement nommées (`QA_*`), jamais passés en argument ni écrits. Les
permissions sont celles du compte : rien n'est contourné.

**Limite de validation :** aucun Confluence réel n'est accessible ici. Les tests jouent un serveur
simulé qui reproduit les réponses documentées des deux variantes. Ils ne valent pas validation
contre un vrai Confluence (Q2).

### D5 — Classification sans IA, expliquée

La normalisation applique des règles explicites et documentées. Elles portent sur :

- les identifiants (`REQ-12`, `RG-3`, `CA-7`…) ;
- la section où se trouve le bloc (« Exigences », « Règles d'affaires », « Critères
  d'acceptation »…) ;
- la forme Étant donné / Quand / Alors ;
- les verbes normatifs (« doit », « must », « shall »).

Chaque candidat porte sa confiance (`HIGH`, `MEDIUM`, `LOW`, `NOT_EVALUATED`) et les raisons qui
l'ont produite. Ces niveaux sont des **classes de règles**, pas des probabilités. Rien n'est publié
sans décision humaine. Une IA pourra proposer plus tard ; elle ne décidera pas.

### D6 — Liens de traçabilité : extension, pas de second graphe

Le moteur calcule déjà des liens par run (`COVERS`, `VERIFIES`, `DEPENDS_ON`, `CONFLICTS_WITH`,
`DERIVED_FROM`). Le référentiel garde les liens **persistés** et ajoute ce qui manque :

- la confiance ;
- la validation humaine ;
- l'historique des décisions ;
- les versions ;
- la fraîcheur.

| Lien du référentiel | Lien du moteur repris  | Sens                                      |
| ------------------- | ---------------------- | ----------------------------------------- |
| `HAS_RULE`          | règle `requirementIds` | exigence → règle d'affaires               |
| `HAS_CRITERION`     | —                      | exigence ou règle → critère d'acceptation |
| `DEPENDS_ON`        | `DEPENDS_ON`           | exigence → exigence                       |
| `DERIVED_FROM`      | `DERIVED_FROM`         | règle → contrat OpenAPI ou autre source   |
| `IMPLEMENTED_BY`    | —                      | exigence → élément de code (phase 5)      |
| `TESTED_BY`         | `COVERS`               | exigence → test (flow, scénario)          |
| `VERIFIED_BY`       | `VERIFIES`             | règle ou critère → assertion              |
| `OBSERVED_IN`       | preuves du run         | assertion → preuve d'une exécution        |

Le pont vers le moteur se fait en phase 5 : les exigences et règles **publiées** alimentent la
mission (`requirements`, `businessRules`). Le moteur calcule alors leur vérification à chaque run,
avec ses statuts existants : aucune règle n'est réécrite.

## 5. Plan et critères d'acceptation par phase

| Phase | Contenu                                                                                                                 | Critère d'acceptation                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | Audit, conception (ce document)                                                                                         | décisions écrites, statuts justifiés par des tests nommés                                             |
| 2     | Modèle canonique, contrat de connecteur, normalisation, doublons, lots, décisions, publication, historique, persistance | tests unitaires : identifiants, provenance, doublons, conflits, ambiguïté, décisions, versions        |
| 3     | Connecteur Confluence (une page puis plusieurs) : Cloud et Data Center, erreurs, limites                                | tests contre un serveur simulé (dits simulés) : succès, 401, 403, 404, 429, réseau, taille            |
| 4     | Connecteurs Word et Excel (D2), PDF selon Q4                                                                            | fixtures réelles générées par les tests ; avertissements explicites                                   |
| 5     | Corrélation : identifiants explicites, Gherkin, OpenAPI, analyse statique existante, runs ; pont vers la mission        | chaque proposition cite ses éléments ; « aucune implémentation identifiée dans le périmètre analysé » |
| 6     | SDK, CLI (`requirements …`), Dashboard (« Exigences et traçabilité »)                                                   | mêmes contrats partout ; tests de cohérence                                                           |
| 7     | Indicateurs (formules), fraîcheur, sécurité, documentation, rapport final                                               | chaque indicateur dit périmètre, dénominateur, exclusions                                             |

## 6. Questions ouvertes (`À_CLARIFIER`)

- **Q1 — Utilisateurs et rôles.** Voir `docs/sdk/MASTER-PLAN.md`. En attendant, une décision porte
  le nom donné par l'appelant (`by`). Le service ne l'authentifie pas.
- **Q2 — Confluence cible.** Cloud, Data Center ou les deux ? Une URL et un compte de test
  permettraient la validation réelle que les tests simulés ne remplacent pas.
- **Q3 — Préfixes d'identifiants.** Les préfixes reconnus par défaut sont listés dans
  `classify.ts`. Les conventions maison se règlent par un profil d'importation.
- **Q4 — PDF.** Faut-il ajouter `pdfjs-dist` (D3) ? Faut-il un OCR ?

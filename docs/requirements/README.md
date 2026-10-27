# Référentiel d'exigences

Le module `src/requirements/` construit un référentiel d'exigences à partir de sources documentaires.
Chaque élément garde sa provenance. Rien n'entre dans le référentiel sans décision humaine.
L'audit, l'architecture et les décisions sont dans [AUDIT-ET-CONCEPTION.md](AUDIT-ET-CONCEPTION.md).

| Capacité                                                                              | État                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Modèle canonique, normalisation, doublons, décisions, publication, liens, persistance | disponible, testé (`requirements-foundation.test.ts`)                   |
| Connecteur Confluence (Cloud, Data Center)                                            | disponible, testé contre un serveur **simulé** seulement                |
| Connecteurs Word, Excel                                                               | non disponibles (phase 4)                                               |
| Connecteur PDF                                                                        | non disponible ; décision attendue (Q4)                                 |
| Corrélation avec le code, les tests, les preuves                                      | non disponible (phase 5)                                                |
| SDK, CLI, Dashboard                                                                   | non disponibles (phase 6) : le module s'utilise aujourd'hui depuis Node |

## Parcours

```ts
// Depuis le dépôt : l'export public (@qa-crawler/core) viendra avec les interfaces, en phase 6.
import {
  ConfluenceConnector,
  decide,
  importSource,
  publish,
  RequirementsStore,
} from './src/requirements/index.js';

const store = new RequirementsStore('<projet>/requirements');
const batch = await importSource(
  store,
  new ConfluenceConnector(),
  {
    baseUrl: 'https://example.atlassian.net',
    page: 'https://example.atlassian.net/wiki/spaces/DEM/pages/65538/Specification',
    auth: { userEnv: 'QA_CONFLUENCE_USER', tokenEnv: 'QA_CONFLUENCE_TOKEN' },
  },
  { now: new Date(), env: process.env },
);
// batch.status : VALIDATION_REQUIRED (ou PARTIAL, FAILED…) ; batch.items : les candidats, avec leurs raisons
await decide(
  store,
  batch.id,
  [{ itemId: 'itm_0002', decision: { action: 'ACCEPT', by: 'analyste' } }],
  new Date(),
);
await publish(store, batch.id, new Date());
```

## Modèle canonique

| Entité                | Contenu principal                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Requirement`         | identifiant interne stable, identifiant externe, titre, description, type, priorité, statut, dépendances                                                |
| `BusinessRule`        | description, préconditions, conditions, résultat attendu, exceptions, contraintes                                                                       |
| `AcceptanceCriterion` | texte, structure Étant donné / Quand / Alors quand elle existe (cas négatif repéré), observables                                                        |
| `SourceReference`     | type, identifiant stable, URL, titre, lieu (bloc, section, page, feuille, cellule, ligne), version, date de modification, date d'importation, empreinte |
| `TraceabilityLink`    | type, extrémités (avec leur version), origine, justification, confiance, validation, décisions, fraîcheur                                               |

Toute entité porte :

- toutes ses provenances ;
- sa version ;
- son historique (création, mise à jour, fusion), avec l'ancien texte et l'auteur de la décision ;
- l'indication `edited` quand une personne a corrigé le texte.

## Contrat d'un connecteur

```ts
interface SourceConnector<Input> {
  kind: SourceKind;
  describe(): ConnectorDescription; // formats, taille maximale, capacités, limites
  validate(input, context): ImportIssue[]; // avant tout accès
  extract(input, context): Promise<ExtractedDocument>; // blocs + lieux, liens, problèmes, complétude
}
```

Un connecteur ne fait qu'accéder et extraire. Les erreurs d'accès sont des `ConnectorError` avec un
code :

- `AUTHENTICATION`, `PERMISSION`, `NOT_FOUND`, `RATE_LIMITED` ;
- `NETWORK`, `TIMEOUT`, `TOO_LARGE`, `CORRUPTED` ;
- `UNSUPPORTED`, `INVALID_INPUT`, `CANCELLED`.

Une lecture partielle est rendue `PARTIAL`, jamais comme complète.

**Ajouter une source :** écrire une classe qui implémente ce contrat et rend des blocs (`heading`,
`paragraph`, `list`, `table`) avec leur lieu. Le modèle, la normalisation, les doublons et la
publication ne changent pas.

## Normalisation : règles et confiance

Les règles sont explicites ; chaque candidat porte ses raisons. Les niveaux sont des **classes de
règles**, pas des probabilités.

| Confiance       | Règle                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `HIGH`          | identifiant explicite d'un préfixe connu (`REQ-12`, `RG-3`, `CA-7`), ou ligne de tableau avec une colonne identifiant                |
| `MEDIUM`        | section qui nomme le type, forme Étant donné / Quand / Alors, ligne de tableau sans identifiant, ou préfixe qui contredit la section |
| `LOW`           | verbe normatif seul (« doit », « must », « shall »), ou ligne d'un tableau sans en-tête reconnu                                      |
| `NOT_EVALUATED` | information : aucun signal ; non proposée à la publication                                                                           |

Préfixes reconnus par défaut :

| Type                  | Préfixes                                             |
| --------------------- | ---------------------------------------------------- |
| Exigence              | `REQ`, `EXG`, `EF`, `ENF`, `NFR`, `FR`, `US`, `SPEC` |
| Règle d'affaires      | `RG`, `RM`, `RA`, `BR`, `RULE`                       |
| Critère d'acceptation | `CA`, `AC`                                           |

Un profil d'importation peut remplacer ces préfixes (`classify.idPrefixes`). Il peut aussi imposer
la correspondance des colonnes d'un tableau (`classify.columns`).

Un titre qui porte un identifiant ouvre un candidat dont le corps est le texte qui suit. Une règle
proposée est rattachée à la dernière exigence de sa section, un critère à la dernière règle ou
exigence : le lien est **proposé**, il n'est confirmé que si la personne donne le parent.

## Doublons et conflits

| Résultat               | Cas                                                  | Ce qui se passe                                                                                               |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `UNCHANGED`            | même élément, même texte                             | rien à décider                                                                                                |
| `SOURCE_CHANGED`       | même identifiant, même source, texte modifié         | décision requise ; acceptée, une nouvelle version garde l'ancien texte, et ses liens passent `POSSIBLY_STALE` |
| `SAME_ID_OTHER_SOURCE` | même identifiant venu d'une autre source             | fusion (provenance ajoutée) ou rejet ; jamais une seconde copie silencieuse                                   |
| `SIMILAR`              | texte proche sans identifiant commun (indice ≥ 0,75) | fusion **proposée** seulement                                                                                 |
| `NEW`                  | rien de proche                                       | création après acceptation                                                                                    |

Un élément absent de la nouvelle version de sa source est listé dans `missingFromSource`. Il n'est
jamais supprimé.

## Statuts d'un lot

| Statut                    | Sens                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `RUNNING`                 | lecture en cours                                                              |
| `VALIDATION_REQUIRED`     | des candidats attendent une décision                                          |
| `PARTIAL`                 | une partie de la source n'a pas été lue ; publier demande un accord explicite |
| `COMPLETED`               | tout est décidé ou inchangé                                                   |
| `COMPLETED_WITH_WARNINGS` | idem, avec des avertissements                                                 |
| `FAILED`                  | entrée invalide ou accès refusé : le code est dans les problèmes              |

## Confluence

| Variante    | Requête                                                        | Authentification                                          |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Cloud       | `GET /wiki/api/v2/pages/{id}?body-format=storage`              | `auth.userEnv` (courriel) + `auth.tokenEnv` (jeton d'API) |
| Data Center | `GET /rest/api/content/{id}?expand=body.storage,version,space` | `auth.tokenEnv` (jeton d'accès personnel, Bearer)         |

- **Cible :** les deux variantes sont prises en charge à égalité. Data Center est la cible annoncée
  (à confirmer).
- **Variante :** `variant` explicite, sinon déduite de l'hôte (`*.atlassian.net` : Cloud).
- **Adresse de la page**, pour les deux variantes, chacune par son API officielle :

  | Forme           | Exemple                                                                    | Résolution                                                                                                                                        |
  | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | identifiant     | `123`                                                                      | lecture directe                                                                                                                                   |
  | URL de page     | `…/spaces/DEM/pages/123/Titre`, `…/viewpage.action?pageId=123`             | lecture directe                                                                                                                                   |
  | espace et titre | `…/display/DEM/Titre+de+la+page`, `…/viewpage.action?spaceKey=DEM&title=…` | Cloud : espace par clé, puis page par titre (API v2) ; Data Center : `GET /rest/api/content?spaceKey=…&title=…`                                   |
  | lien court      | `…/x/AgAB`                                                                 | le serveur redirige vers la page ; l'adresse de redirection est lue (même hôte seulement), jamais suivie avec les identifiants vers un autre hôte |

- **Installation sous un sous-chemin** (Data Center : `https://hote/confluence`) : donner ce chemin
  dans `baseUrl`.
- **Authentification :**
  - Cloud : courriel et jeton d'API (Basic) ;
  - Data Center : jeton d'accès personnel (Bearer) ;
  - anciens serveurs sans jeton personnel : `auth.userEnv` (utilisateur) et `auth.tokenEnv` (mot de
    passe), en Basic.
- **Secrets :** lus dans des variables `QA_*` nommées, jamais passés en argument ni écrits.
- **Sécurité :** `https` obligatoire (`http` seulement sur la machine locale). Les redirections ne
  sont pas suivies.
- **Limites :**
  - délai de 30 s ;
  - 5 Mo par page ;
  - 3 réessais après une limitation, selon `Retry-After`, bornés à 30 s chacun.
- **Lus :** titres, paragraphes, listes et listes à cocher, tableaux, macros de mise en page
  (expand, panel, info…) et libellé des macros de statut. Les liens sont relevés, jamais suivis.
- **Non lus, et signalés :**
  - les macros d'inclusion : la lecture devient `PARTIAL` ;
  - les images et les pièces jointes ;
  - les macros inconnues : leur corps texte est lu ;
  - le code.
- **Validation :** contre un serveur **simulé** seulement. La validation contre un Confluence réel
  reste à faire (Q2).

## PDF

```ts
await importSource(
  store,
  new PdfConnector(),
  { file: 'specification.pdf' },
  { now: new Date(), env: process.env },
);
```

- **Lus :** le texte de chaque page, reconstruit en blocs avec le numéro de page :
  - titres, d'après la taille de la police ;
  - paragraphes, d'après l'écart vertical ;
  - listes : puces et numéros.
- **Non lus, et signalés :**
  - une page sans couche texte (scan) : `PAGE_WITHOUT_TEXT` ; la lecture devient `PARTIAL` ;
  - un document surtout scanné : `SCANNED_DOCUMENT` ;
  - les pages au-delà de la limite : `PAGES_NOT_READ`.
- **Refusés :** un fichier qui n'est pas un PDF ou qui est corrompu (`CORRUPTED`), trop grand
  (`TOO_LARGE`), trop long à lire (`TIMEOUT`), ou protégé par mot de passe (`UNSUPPORTED`).
- **Limites :**
  - les tableaux sont lus comme des lignes de texte ;
  - aucun OCR ;
  - les titres sont devinés d'après la police, donc jamais au-delà d'une confiance moyenne sans
    identifiant.
- **Sécurité :** voir la décision D3 (worker isolé, `isEvalSupported: false`, aucun accès réseau).
- **Bornes par défaut :** 25 Mo, 500 pages, 60 s, 512 Mo de mémoire pour le worker. Toutes se
  règlent dans l'entrée.

## Persistance

`<dossier>/repository.json` contient le référentiel ; `<dossier>/imports/<lot>.json` contient un lot.
Les fichiers sont du JSON lisible, écrit de façon atomique, et les écritures passent en série. Rien
n'est supprimé.

## Tests

- `tests/unit/requirements-foundation.test.ts` : normalisation (identifiants, sections, Étant donné /
  Quand / Alors, tableaux, profils, identifiants en double), import et validation requise, décisions
  et publication (provenance, versions, historique, liens proposés ou confirmés), réimportation
  inchangée, source modifiée, élément disparu, conflit d'identifiant, texte proche, lecture
  partielle, échecs, liens rejetés jamais réactivés, liens manuels, persistance. Connecteur de
  **test** en mémoire.
- `tests/unit/requirements-confluence.test.ts` : format storage vers blocs, éléments non lus
  signalés, balisage réparé, formes d'adresse, validation de l'entrée, Cloud et Data Center (identifiant, `/display/`, espace et titre, lien court, sous-chemin, Basic des anciens serveurs ; titre, espace ou lien court introuvable ; lien court vers un autre hôte refusé),
  erreurs 401, 403, 404, redirection, réponse non JSON, délai, limitation 429, taille, réseau,
  annulation, import complet sans secret stocké. Serveur **simulé**.
- `tests/unit/requirements-pdf.test.ts` : options sûres de pdf.js ; de vrais PDF générés par le test
  et lus par pdf.js. Il couvre :
  - titres, paragraphes, listes, page de chaque bloc, accents ;
  - page scannée et document surtout scanné ;
  - limite de pages ;
  - document protégé, faux PDF, PDF cassé, trop grand, délai dépassé, fichier absent, dossier ;
  - import complet avec la page dans la provenance ;
  - en dessous de Node 22.13, l'import se dit indisponible.

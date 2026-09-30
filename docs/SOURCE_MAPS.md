# Source maps : une nouvelle source d'entrée pour l'analyse statique

Cette évolution change **uniquement la manière dont le StaticApplicationAnalyzer obtient ses sources**. Aucun analyseur n'est réécrit : routes, formulaires, validateurs, DTO, appels HTTP, flux de données, `StaticKnowledge`, `FieldMatcher` et Dry Run restent ceux d'avant et lisent le même `SourceSet`.

```
URL déployée → scripts chargés (runtime) → BundleInventory → sourceMappingURL / SourceMap / inline
  → SourceMapReader → SourcePathNormalizer → VirtualSourceWorkspace (mémoire)
  → StaticApplicationAnalyzer (existant) → StaticKnowledge → résolution du champ muet
```

## 1. Rapport d'architecture

### Architecture existante

| Élément                                                  | Rôle                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `source-set.ts` — `SourceSet`, `collectSources`          | l'entrée unique de l'analyseur : fichiers (chemin, texte, empreinte), empreinte d'ensemble, budget |
| `static-analyzer.ts` — `analyzeSource`, `analyzeSet`     | empreinte → cache → `buildStaticGraph` → événements ; jamais d'exécution du code                   |
| `graph-builder.ts`, `ts-facts.ts`, `template-scanner.ts` | les analyseurs (AST du compilateur TypeScript, gabarits)                                           |
| `cache.ts` — `StaticAnalysisCache`                       | un JSON par identité (application, mode, empreinte, version, commit, version de l'analyseur)       |
| `static-knowledge.ts`                                    | index en mémoire, provenance des champs (`FieldProvenance`)                                        |
| `bundle.ts` (avant)                                      | mode bundle basique : scripts du document, source map par commentaire, préfixe `sourcemap/`        |
| `flow-explorer.ts` — `loadStaticKnowledge`               | choix source / bundle, à la demande ou au début                                                    |

### Composants réutilisés tels quels

`SourceSet` et son empreinte, `analyzeSet`, `buildStaticGraph` et tous les analyseurs, `StaticAnalysisCache` (clé d'identité inchangée), `sanitizeGraph`, `StaticKnowledge`, `FieldMatcher`, le journal du moteur, la section « Analyse statique » du rapport, `AllowedOriginPolicy` (`safety.navigation.isAllowedHost`).

### Points d'extension

- `SourceSet.notes` / `SourceSet.provenance` : limites de la lecture (→ couverture PARTIAL) et provenance de chaque fichier, sans contenu.
- `StaticApplicationGraph.sources` : la provenance suit le graphe (cache, rapport).
- `StaticAnalysisMode` : `SOURCE_MAP` et `HYBRID` en plus de `SOURCE` et `BUNDLE`.
- `StaticAnalysisCache.getByAlias` / `putAlias` : l'empreinte des bundles déployés (`bundleSetHash`) mène à une analyse connue avant toute source map.
- `FieldProvenance.sourceOrigin` : chaque explication dit d'où vient le code cité.
- `StaticAnalysisEvent` étendu des événements de découverte ; `StaticAnalysisSummary.discovery`.

### Fichiers modifiés

`source-set.ts`, `model.ts`, `graph-builder.ts` (notes et provenance), `sanitize.ts` (les empreintes `*Hash` restent exactes), `cache.ts` (alias), `static-analyzer.ts` (alias, événements), `static-knowledge.ts` (`sourceOrigin`), `bundle.ts` (adaptateurs Playwright), `field-matcher.ts` (origine dans l'explication), `flow-explorer.ts` (découverte, observation des scripts, enrichissement), `config.ts`, `engine-log.ts`, `static-section.ts`, tests et documentation.

### Fichiers créés

| Fichier                          | Contenu                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `sources/model.ts`               | origines `REPOSITORY` / `SOURCE_MAP` / `BUNDLE`, provenance, événements, résumé                   |
| `sources/bundle-inventory.ts`    | `BundleInventory`, `BundleDescriptor` (url, empreinte, taille, runtime, lazy, source map, état)   |
| `sources/source-map-reader.ts`   | découverte de la référence, décodage inline borné, lecture et validation (v3, index maps)         |
| `sources/path-normalizer.ts`     | `SourcePathNormalizer` : schémas, `sourceRoot`, traversée, chemins absolus, exclusions            |
| `sources/virtual-workspace.ts`   | `VirtualSourceWorkspace` : déduplication, conflits, écarts dépôt ↔ build, budget                  |
| `sources/source-providers.ts`    | `StaticSourceProvider`, `RepositorySourceProvider`, `RuntimeBundleSourceProvider` (maps + repli)  |
| `sources/source-discovery.ts`    | `StaticSourceDiscovery` : stratégies auto / source / source-map / bundle / hybrid, enrichissement |
| `tests/unit/source-maps.test.ts` | normalisation, lecture, workspace, fournisseurs, cache, hybride, budgets, performance             |

## 2. Configuration

```yaml
staticAnalysis:
  enabled: true
  mode: auto # auto | source | source-map | bundle | hybrid
  source: { root: ../mon-application } # facultatif
  sourceMaps:
    enabled: true
    discoverFromRuntime: true # suivre les scripts reçus par le navigateur
    inline: true # data:application/json;base64,…
    external: true # commentaire sourceMappingURL, en-tête SourceMap / X-SourceMap
    incrementalChunks: true # chunks chargés plus tard : workspace enrichi
  bundleFallback: { enabled: true } # sans source map utilisable : le bundle lui-même
  budgets:
    maxBundles: 50
    maxSourceMaps: 50
    maxSourceMapBytes: 20000000
    maxExtractedSources: 2000
```

**auto** : le dépôt s'il donne au moins un fichier ; sinon les source maps du déploiement ; pour chaque bundle sans source map utilisable, le bundle lui-même. **hybrid** : dépôt + déploiement, corrélés par chemin normalisé ; un fichier dont le contenu diffère donne `SOURCE_BUILD_MISMATCH` et le contenu **déployé** est gardé (c'est lui qui s'exécute).

## 3. Sécurité

- Scripts et source maps lus seulement sur les **hôtes autorisés** par la mission, avec la session du navigateur, **sans redirection**.
- Aucune adresse devinée : seules les références publiées (commentaire, en-tête, inline) sont suivies.
- Tailles bornées **avant** décodage ; JSON validé (v3, formes de `sources` / `sourcesContent`) ; index maps à sections inline seulement.
- Chemins non fiables : schémas `webpack:`, `ng:`, `file:`, `http(s):` réduits ; autres schémas (`javascript:`, `data:`) rejetés ; caractères de contrôle rejetés ; `..` bornés à la racine ; chemins absolus d'un poste de build réduits à partir de `src/`. `sourceRoot` suit les mêmes règles.
- Le workspace vit **en mémoire** ; rien n'est écrit ni exécuté. Le graphe mis en cache et le rapport ne portent que noms, chemins, adresses sans paramètres et empreintes : le **code source n'apparaît jamais** dans le rapport HTML, `result.json`, le journal ou la console (vérifié par les tests avec un marqueur).
- Une source map invalide, trop grande ou refusée : `SOURCE_MAP_REJECTED`, repli sur le bundle, le run continue.

## 4. Événements

`BUNDLE_DISCOVERED`, `SOURCE_MAP_REFERENCE_DISCOVERED`, `SOURCE_MAP_LOADING_STARTED`, `SOURCE_MAP_LOADED`, `SOURCE_MAP_PARTIAL`, `SOURCE_MAP_REJECTED`, `SOURCE_EXTRACTED`, `SOURCE_CONTENT_CONFLICT`, `SOURCE_BUILD_MISMATCH`, `BUNDLE_FALLBACK_STARTED`, `LAZY_BUNDLE_DISCOVERED`, `VIRTUAL_WORKSPACE_CREATED`, `VIRTUAL_WORKSPACE_ENRICHED` — en plus des `STATIC_ANALYSIS_*` existants. Rejets, conflits, écarts et replis sont des avertissements ; le détail (extraction, références) est au niveau DEBUG.

## 5. Rapport

La section « Analyse statique » gagne « Découverte des sources » : stratégie, origines, bundles lus (dont à la demande), source maps (référencées / chargées / partielles / rejetées), sources extraites, bundles sans source map, conflits, écarts dépôt ↔ build, empreinte des bundles, et un tableau bundle → source map → état → nombre de sources. Chaque résolution de champ cite l'origine de son code : `[code from SOURCE_MAP https://…/main.js.map]`.

## 6. Performance

- L'inventaire (lecture des bundles, empreintes) précède toute source map : un déploiement déjà analysé est reconnu par `bundleSetHash` et **aucune source map n'est téléchargée**.
- Extraction mesurée : 20 bundles × 100 sources (2 000 fichiers, ≈ 4 Mo de source maps) en ≈ 0,1 s ; l'analyse elle-même reste celle d'avant.
- Les chunks à la demande ne relancent l'analyse que lorsqu'un champ ne se résout pas sans elle, et seulement si le workspace a changé ; les confirmations d'exécution sont conservées.

## 7. Limites

- Les `mappings` ne sont pas décodés : l'analyseur lit les sources d'origine, sans remonter du minifié aux lignes.
- Une section d'index map désignée par URL n'est pas suivie (notée PARTIAL).
- Deux source maps qui donnent deux contenus pour le même chemin : le premier est gardé (`SOURCE_CONTENT_CONFLICT`).
- Une source map partielle (certaines sources sans `sourcesContent`) n'est pas complétée par le bundle, pour ne pas mélanger code d'origine et code minifié du même module.

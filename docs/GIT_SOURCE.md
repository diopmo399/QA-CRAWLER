# Analyse statique depuis le dépôt git de l'application

Quand ni `source.root` (le code sur le disque) ni les source maps publiées ne sont disponibles, l'analyse statique peut lire le code **depuis le dépôt git** de l'application. Une application minifiée sans source map ne donne qu'une couverture LIMITED. Le code du dépôt donne les noms d'origine : champs, validateurs, DTO, routes et règles.

## Configuration

```yaml
staticAnalysis:
  enabled: true
  mode: hybrid # le code du dépôt d'abord, les bundles du navigateur en complément
  source:
    git:
      url: https://git.example.test/team/app.git
      ref: main # branche, tag ou commit (défaut : la branche par défaut)
      path: frontend # sous-dossier analysé (mono-repo), optionnel
      tokenEnv: GIT_TOKEN # NOM de la variable d'environnement qui contient le jeton
      # usernameEnv: GIT_USER   # optionnel ; sinon « x-access-token »
    # gitDirectory: ./.qa-crawler/sources   # où cloner (défaut : à côté du dossier des rapports)
    # gitTimeoutMs: 180000
```

Pour plusieurs dépôts, par exemple des micro-frontends (le shell plus chaque application), donnez une liste :

```yaml
git:
  - { url: https://git.example.test/team/shell.git, ref: main, tokenEnv: GIT_TOKEN }
  - { url: https://git.example.test/team/requests.git, ref: main, tokenEnv: GIT_TOKEN }
```

Chaque dépôt est cloné dans son dossier. La racine analysée est alors le dossier qui les réunit, et `path` est ignoré (note GIT_SOURCE_PATH_IGNORED).

`source.root`, s'il est renseigné, reste prioritaire : le dépôt n'est alors pas cloné.

## Règles de l'application

Les règles se **lisent dans le code**. Exemples : « type = business → numéro obligatoire », « âge < 18 → tuteur », « pays change → provinces chargées ». Un bundle minifié ne les contient pas sous une forme lisible. Avec le dépôt, elles sont extraites puis vérifiées dans le navigateur :

```yaml
staticAnalysis:
  enabled: true
  source:
    git: { url: https://git.example.test/team/app.git, ref: main, path: frontend, tokenEnv: GIT_TOKEN }
rules:
  enabled: true # désactivé par défaut
```

Chaque règle part de STATIC_DISCOVERED (lue dans le code), puis passe à RUNTIME_CONFIRMED, RUNTIME_CONTRADICTED ou NOT_VERIFIED. Si la section du rapport reste vide, elle dit pourquoi :

- **aucun code lu** : analyse statique indisponible ou désactivée ;
- **seulement des bundles minifiés** (BUNDLE) ;
- **N fichiers lus mais aucun formulaire réactif reconnu** : le `path` ne pointe probablement pas sur le dossier du front-end.

## Comportement

- **Clone léger, lecture seule.** Le premier run fait `--depth 1`, une seule branche, sans tags ni sous-modules. Les runs suivants font `fetch` puis `checkout --force` sur la révision distante.
- **Rien n'est poussé.** Aucun commit n'est fait et aucun hook n'est exécuté (`core.hooksPath` vide).
- **Un dossier par ensemble de dépôts** (empreinte des URL, ref et path). Deux missions qui n'analysent pas les mêmes dépôts ne se mélangent pas.
- **Cache de l'analyse.** Le code inchangé (même empreinte) n'est pas ré-analysé.
- **Échec** (réseau, droits, ref inconnue, délai dépassé) :
  - le run continue sans ce code ;
  - l'analyse se rabat sur les source maps et les bundles ;
  - la raison (`fatal: …`) est dans l'événement `GIT_SOURCE_FAILED`.
- **Événements :**
  - `GIT_SOURCE_FETCHED` : URL, ref, cloné ou mis à jour, commit ;
  - `GIT_SOURCE_FAILED` : la raison.

## Sécurité

- **Jeton :**
  - **Jamais dans l'URL ni dans le fichier de mission.** Une URL `https://user:secret@…` est refusée à la lecture de la configuration. Le jeton vient de la variable nommée par `tokenEnv`.
  - **Transmis uniquement par un en-tête HTTP de la commande** (`http.extraHeader`, Basic). Il n'est jamais écrit dans `.git/config`, ni dans un rapport, ni dans un journal.
  - **Envoyé seulement en `https://`.**
- **Aucune invite interactive** (`GIT_TERMINAL_PROMPT=0`), aucun gestionnaire d'identifiants et aucun TLS désactivé. Les URL `ssh://` et `git@host:` utilisent la clé SSH de la machine.
- **URL acceptées :** `https://`, `ssh://`, `git@host:…` et `file://`.
- **Journaux :** les URL y apparaissent sans identifiant ni paramètre, et les messages d'erreur sont expurgés.
- **Dossier de clonage :** il contient du code de l'application. Gardez-le hors de tout dépôt versionné (`.qa-crawler/` est ignoré par git).
- **Code source :** il n'apparaît jamais dans le rapport, seulement des chemins et des noms.

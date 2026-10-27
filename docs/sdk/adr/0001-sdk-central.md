# ADR 0001 — Le SDK central : un service local, un client, une façade Node

- Statut : accepté
- Portée : SDK, CLI de la plateforme, Dashboard

## Contexte

Trois interfaces doivent piloter QA-CRAWLER : un SDK (pour les hôtes et les programmes), une CLI
(automatisation, CI) et un Dashboard (pilotage). Le moteur est en TypeScript sur Node 20+. Il
pilote Chromium par Playwright, lit le disque et ouvre des bases de données : il ne peut pas
tourner dans un navigateur. Les règles de sécurité sont dans le moteur et le serveur : SafetyPolicy,
environnements, secrets par nom, archivage, confirmation d'une suppression.

## Décision

1. **Un seul moteur, derrière un service HTTP local** (`src/sdk/server`). Il expose un contrat
   versionné (`SDK_API_VERSION`, ajouts seuls) avec un jeton, une liste d'origines et des flux
   d'événements numérotés. Toutes les règles sont vérifiées ici.
2. **Un client sans dépendance** (`src/sdk/core`, `fetch` seulement), le même dans le navigateur
   et dans Node. Les composants d'interface (`src/sdk/ui`, Web Components) et le Dashboard s'en
   servent.
3. **Une façade Node** (`openQaCrawler`) démarre le service dans le programme (127.0.0.1, port
   libre, jeton aléatoire jamais affiché) et rend le client. Un script ou un outil interne passe
   ainsi par le même contrat, sans serveur à lancer à part.
4. **La CLI de la plateforme est un client du SDK.** Elle ouvre la façade (`--workspace`) ou se
   connecte à un `sdk-server` (`--endpoint`). Elle n'a aucune règle propre.
5. **Le Dashboard est un client du SDK**, construit avec les mêmes Web Components, sans nouveau
   framework.

## Conséquences

- Une règle ajoutée au serveur vaut pour les trois interfaces ; un bouton du Dashboard ne donne
  aucun droit que l'API refuse.
- Un appel du SDK en Node passe par HTTP local même dans un seul programme. Le coût est faible face
  à une exécution de navigateur, et le contrat reste unique.
- L'état vivant d'une exécution est dans le service qui la joue. `run status` et `run cancel`
  visent donc un `sdk-server` ; un service ouvert pour une commande se ferme avec elle, en annulant
  ce qui tourne.
- Les commandes historiques de la CLI (mission, projet, dry run) restent : elles appellent le moteur
  directement et gardent leurs codes de sortie.

## Options écartées

- **Bibliothèque Node appelant le moteur en direct** : les règles seraient copiées entre le serveur
  et la bibliothèque, et le navigateur n'y aurait pas accès.
- **Un framework d'interface (React, Angular) pour le Dashboard** : une dépendance de plus pour les
  hôtes, alors que les Web Components s'intègrent partout.
- **gRPC ou WebSocket** : HTTP et des flux d'événements suffisent, traversent les proxys et se
  lisent avec `fetch`.

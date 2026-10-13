# Restauration du contexte à la reprise d'un rejeu corrigé

Quand une étape du rejeu échoue et que l'humain la corrige, reprendre « à la même URL » ne suffit pas.
Une application monopage garde son état en mémoire, un critère de recherche vit dans une requête, une
entité créée pendant le run porte un identifiant que le prochain run n'aura pas. La reprise doit
retrouver le **contexte fonctionnel** de l'étape, ou dire honnêtement qu'elle ne le peut pas.

```
Rejeu → échec → correction dans le navigateur → restauration du contexte
      → validation des préconditions → reprise À L'ÉTAPE CORRIGÉE (même run, mêmes données)
```

## Ce qui existait, et ce qui est réutilisé

| Brique existante                                   | Rôle dans la reprise                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Session de correction (`correction-session.ts`)    | suit le même chemin (étapes 1 à N-1) puis **garde la page** : c'est la reprise |
| Pilote du Dry Run (`DryRunDriver.perform`)         | exécute chaque étape (SafetyPolicy, effets) : aucun second moteur de rejeu     |
| `TestDataRunContext`                               | les données du run : une valeur par clé et par run, reprise telle quelle       |
| Préconditions (`src/replay/preconditions.ts`)      | « Can I execute this action? » : vérifiées avant de reprendre                  |
| Historique des corrections (`corrections` du flow) | la correction reste séparée de l'enregistrement d'origine                      |

Nouveau : `src/replay/context-checkpoint.ts` (modèle et décision, pur) et
`src/replay/context-capture.ts` (capture dans la page, lecture seule).

## Le checkpoint de contexte

Pris **devant chaque étape** de la session (`replay.contextRecovery.checkpoints`), donc aussi devant une
étape de création, une recherche, une étape susceptible d'échouer, et après une correction validée.

| Partie           | Contenu                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Identité         | scénario, run, étape, date de capture, version du schéma                                       |
| Navigation       | URL complète, chemin, paramètres, fragment, titre, route applicative, longueur de l'historique |
| Navigateur       | cadres (iframes, micro-frontends), onglets sélectionnés, dialogue, overlay, défilement         |
| Formulaires      | champs visibles : libellé, rempli, coché ; la valeur seulement si non sensible et courte       |
| Sélection        | lignes sélectionnées (`aria-selected`)                                                         |
| État fonctionnel | contrôles visibles et activés (rôle:nom), champs, onglets, dialogue                            |
| Données du run   | clé → valeur en mémoire ; sur disque, des **empreintes** seulement                             |
| Exécution        | étapes à effet métier déjà faites, préconditions de l'étape                                    |

Rien de JavaScript n'est lu ni écrit dans l'application : un état en mémoire (Angular, React, Vue) se
**reconstruit** par le rejeu des étapes, jamais par l'écriture d'un objet. Les mots de passe, jetons et
champs sensibles n'ont jamais de valeur dans un checkpoint. `replay-checkpoints.json` (dossier de
l'enregistrement) garde les checkpoints avec des empreintes à la place des valeurs.

## La décision : REVALIDATE, RESTORE, REBUILD, MANUAL_RECOVERY

À la reprise, la page tenue est capturée et comparée au checkpoint de l'étape.

| Différence                                                    | Gravité | Effet                             |
| ------------------------------------------------------------- | ------- | --------------------------------- |
| page fermée, route différente, cadre absent, onglet, dialogue | dure    | REBUILD                           |
| page de connexion (session expirée)                           | dure    | MANUAL_RECOVERY, jamais restaurée |
| champ vidé, autre valeur, case décochée                       | souple  | RESTORE si la valeur est connue   |
| paramètre de requête, overlay, ligne désélectionnée           | souple  | signalé                           |
| checkpoint plus vieux que `maxCheckpointAgeMinutes`           | souple  | signalé, la page est revérifiée   |

- **REVALIDATE** : la page est dans l'état du checkpoint. Les préconditions dures de l'étape sont
  vérifiées sur la page, puis l'étape corrigée et la suite sont rejouées.
- **RESTORE** : seuls des champs ont changé et leur valeur est connue (une donnée du run, l'état d'une
  case). Les étapes qui les remplissent sont rejouées avec les mêmes données, puis le contexte est
  recomparé. Toujours différent : la reconstruction prend le relais.
- **REBUILD** : la page est revenue au départ, puis les étapes 1 à N-1 sont rejouées avec **les mêmes
  données du run**. Une étape à effet métier (requête d'écriture enregistrée, permission MUTATION ou
  DANGEROUS) déjà exécutée dans ce run n'est **jamais répétée sans décision** :
  `replay.contextRecovery.repeatMutations: false` (défaut) donne MANUAL_RECOVERY.
- **MANUAL_RECOVERY** : la fenêtre dit pourquoi (session expirée, création qui serait répétée,
  précondition dure non satisfaite, chemin impossible à reconstruire). « Reprendre ici » reste offert :
  l'humain remet la page dans son contexte, ou rejoue depuis le début.

Une URL identique n'est jamais une preuve suffisante : la route est vérifiée, et avec elle le dialogue,
l'onglet, les cadres et les champs.

## Dans la fenêtre du recorder

Après « Valider la correction » dans une page tenue, la revue montre **« Contexte gardé devant l'étape
N »** avec **Reprendre ici** et **Rejouer depuis le début**. Le résultat d'une reprise dit la stratégie
(« Repris à l'étape 4 · contexte vérifié », « champs restaurés », « contexte reconstruit ») et les étapes
rejouées pour le contexte. Si une étape suivante échoue, la page reste tenue **devant cette étape** :
« Corriger dans le navigateur » réutilise la page, rien n'est rejoué.

Une reprise réussie valide le flow corrigé : il a été rejoué en entier dans une seule session, avec les
mêmes données, la reprise faite à l'étape corrigée.

## Configuration

```yaml
replay:
  contextRecovery:
    checkpoints: true # un checkpoint de contexte devant chaque étape de la session
    repeatMutations: false # REBUILD ne répète pas une création déjà faite sans décision
    maxCheckpointAgeMinutes: 30 # au-delà, le checkpoint est signalé périmé
    loginRoutes: [] # les routes de connexion propres à l'application
```

Événements : `REPLAY_CONTEXT_RECOVERY` (stratégie, différences, étapes rejouées), `REPLAY_RESUMED`,
`REPLAY_RESUME_BLOCKED`.

## Limites

- Le rejeu complet « Rejouer le parcours » reste le Dry Run dans un navigateur neuf : son échec ne garde
  pas sa page. La correction qui suit refait le chemin dans une session neuve (un nouveau run, des
  données nouvelles et cohérentes), puis c'est **cette** session qui est gardée et reprise.
- Les requêtes réseau d'un critère de recherche ne sont pas rejouées à l'identique : l'étape qui les
  émet est rejouée, ce qui renvoie la même requête avec la même donnée.
- Un état seulement côté serveur (un brouillon, une réservation) n'est connu que par ses effets à
  l'écran : s'il diffère, la comparaison le voit par la page, jamais par le serveur.

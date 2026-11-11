# Vérification ciblée — conception (non implémentée)

**Statut : conception seulement. Aucun code de vérification ciblée n'est livré par V2.**

But : confirmer une relation incertaine (PROBABLE, AMBIGUOUS, non résolue) par une lecture
supplémentaire **statique** et bornée, sans Playwright, sans test de bout en bout et sans exécuter
d'opération métier.

## Principes retenus

- Une vérification ne porte que sur une relation désignée, jamais sur tout le graphe.
- Sources admissibles : fichiers déjà autorisés par la configuration du scan, contrats OpenAPI,
  métadonnées Maven locales, configuration (profils, proxy). Aucun appel réseau vers les applications.
- Le résultat ne remplace jamais la preuve : il ajoute une `Evidence` (genre, fichier, ligne) et peut
  faire passer PROBABLE → CONFIRMED seulement si la lecture le démontre ; sinon la relation garde son
  état et la tentative est notée.
- Budget borné (fichiers lus, durée) ; dépassement → résultat « non concluant », pas d'hypothèse
  présentée comme preuve.

## Points d'entrée envisagés

- `POST /projects/:id/cartography/verify` avec l'id d'une relation ou d'un lien non résolu.
- Bouton « Vérifier » dans l'onglet « Liens non résolus ».

## Pourquoi ce n'est pas fait

Le mécanisme d'investigation existant (`investigate.ts` : budgets, hypothèses, frontière) couvre déjà
l'exploration bornée d'une branche. Une vérification ciblée qui apporte une preuve nouvelle demande des
lecteurs dédiés par type de relation ; ils n'ont pas été écrits dans ce lot.

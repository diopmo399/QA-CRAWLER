# Démonstration : le référentiel d'exigences

`demo.mjs` importe quatre documents d'une médiathèque **fictive** (Word, Excel, PDF), montre ce que
le pipeline en tire, prend les décisions de la démonstration, publie, puis réimporte une nouvelle
version de la spécification. Tout le contenu de `data/` est inventé.

```bash
npm run build
node examples/requirements-demo/demo.mjs                        # référentiel dans un dossier temporaire
node examples/requirements-demo/demo.mjs --workspace ./exigences  # référentiel dans ./exigences
node examples/requirements-demo/demo.mjs --json                   # une ligne JSON : lots, décisions, référentiel
```

| Étape | Document                            | Ce qu'elle montre                                                                                                                                                                                                                                                             |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `mediatheque-specification-v1.docx` | Exigences, règles et critères rangés par section, chacun avec la raison de son classement et sa classe de confiance. Un parent est proposé dans la section. Une phrase normative sans identifiant reste à classer (FAIBLE). La publication crée les versions 1.               |
| 2     | `mediatheque-portail.xlsx`          | Un profil d'importation (ligne d'en-tête 2 sur la feuille « Exigences »). `REQ-102` déjà pris par le document Word : conflit, refusé. Un texte très proche de `REQ-101` : doublon probable, fusionné. Une colonne « Exigence » qui ne contient qu'un identifiant : le parent. |
| 3     | `mediatheque-annexe-qualite.pdf`    | Des exigences non fonctionnelles lues dans un PDF (sautée si `pdfjs-dist` n'est pas installé).                                                                                                                                                                                |
| 4     | `mediatheque-specification-v2.docx` | La même source, nouvelle version : inchangé, modifié (`REQ-103`, version 2), nouveau (`REQ-107`), retiré (`CA-103`, signalé, jamais supprimé).                                                                                                                                |

**Les décisions sont celles de la démonstration.** Dans un vrai usage, une personne les prend :
rien n'entre dans le référentiel sans décision. Le script les déclare sous le nom `demo`. Les liens
vers les parents restent **proposés** (`PROPOSED`) tant que personne ne les confirme.

Le référentiel est écrit en fichiers JSON lisibles : `repository.json`, `imports/<lot>.json`,
`profiles/portail-excel.json`.

Ce que la démonstration ne fait pas encore : la corrélation avec le code, les tests et les preuves
(phase suivante), et Confluence (il faut un serveur ; voir `docs/requirements/README.md`).

Les documents sont produits par `tests/fixtures/requirements-demo-data.ts` (les mêmes générateurs que
les tests) :

```bash
npx tsx tests/fixtures/requirements-demo-data.ts examples/requirements-demo/data
```

Testé par `tests/integration/requirements-demo.test.ts`.

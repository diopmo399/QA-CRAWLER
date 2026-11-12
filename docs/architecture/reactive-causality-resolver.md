# Causalité réactive

Ce document décrit ce que l'analyse RxJS (`src/cartography/analyze-rxjs.ts`) relie, et ce que V2 y
ajoute. Il distingue trois moments qui étaient confondus :

1. **Installation** : une méthode (souvent `ngOnInit`) souscrit un flux. Cela arrive une fois.
2. **Émission** : une action (`next`, `dispatch`) pousse une valeur dans un flux.
3. **Propagation** : chaque émission traverse le pipe et exécute le rappel abonné.

## Ce qui existait

- Contextes d'appel : `dispatch⟨type='LOAD'⟩` — une méthode générique appelée avec un argument
  littéral est tracée par branche (`switch` / `if` sur le paramètre).
- Flux : `PROPAGATES` (un traitement émet sur un autre flux), lien flux → rappel abonné, opérateurs du
  pipe (`filter`, `switchMap`…) avec leurs appels.

## Ajout V2 : l'installation

Pour chaque pipeline souscrit (`p.subscribed`) dont le flux est résolu, un lien de fait `SUBSCRIBES`
méthode → flux est créé, rendu dans le graphe comme `READS` avec :

- raison : « `OrdersComponent.ngOnInit()` installe un abonnement à `OrderStore.state$` au cycle de vie
  du composant : le rappel s'exécute à chaque émission tant que l'abonnement est actif » (et
  « arrêté par … » quand un `takeUntil` est lu) ;
- détail asynchrone : « installation de l'abonnement (une fois), pas une exécution à chaque émission ».

`READS` est de nature DATA : l'installation n'est pas une cause de l'émission. Elle ne fait donc pas
descendre un parcours de `ngOnInit` vers tous les rappels futurs comme s'il les déclenchait.

## Parcours séparés

Avec l'orientation par `flowOf` (voir `tracegraph-engine-v2.md`), sur la fixture `tracegraph` :

- l'aval de `OrdersComponent#submit` (VALIDATE → SAVE → `saved$` → `create`) n'atteint plus
  `OrderApi#list` ni `OrderStore#load` ;
- l'aval de `reload` (LOAD) n'atteint ni `saved$`, ni `create`, ni `validate` ;
- la provenance de l'état (`state$` → `onState` → condition → conteneur) se lit vers l'amont.

## Canaux d'un flux d'actions partagé

Un même `Subject` d'actions alimente souvent plusieurs traitements filtrés par type :

```ts
saved$ = this.actions.pipe(filter((a) => a.type === 'SAVE'), mergeMap(…create…));
loaded$ = this.actions.pipe(filter((a) => a.type === 'LOAD'), switchMap(…list…));
```

**Traitement filtré par type.** Quand le **premier** opérateur d'un flux calculé garde un type, ce flux
est noté comme filtré sur ce type. Les formes reconnues :

- `filter((a) => a.type === 'X')`, éventuellement avec plusieurs valeurs réunies par `||` ;
- `ofType('X', …)` avec des littéraux.

**Valeur émise.** La valeur poussée par `next(valeur)` est évaluée dans le contexte de l'appel :

- un littéral `{ type: 'SAVE' }` ;
- ou le paramètre `action` d'un `dispatch⟨type='VALIDATE'⟩`.

**Routage.**

- Quand le type émis est connu, l'émission arrive sur un canal `actions⟨type='SAVE'⟩`. Ce canal reprend les
  suites du flux, sauf les traitements filtrés qui n'acceptent pas ce type.
- Un type inconnu arrive sur le flux entier : toutes ses suites restent possibles, rien n'est écarté sans
  preuve.

**Conditions composées.** Une condition `if (action.type === 'VALIDATE' && action.title.length > 0)` est
évaluée terme par terme ; elle reste affichée entière.

## Limites

- Seul le premier opérateur d'un flux est lu comme garde de type. Une garde placée après un `map`, ou écrite
  avec une fonction nommée, n'écarte rien : les suites restent toutes possibles.
- Il n'y a pas d'évaluation générale VRAI / FAUX / INCONNU d'un prédicat quelconque.
- Pas de TypeChecker : un flux référencé par un chemin que la lecture syntaxique ne suit pas reste
  non relié (et non inventé).

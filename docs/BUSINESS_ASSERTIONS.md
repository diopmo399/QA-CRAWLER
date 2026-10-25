# Vérification métier : assertions, cohérence des données, traçabilité

Un clic réussi n'est pas un résultat métier. Un `201 Created` non plus, s'il a enregistré un autre
titre que celui saisi. La vérification métier juge le **résultat attendu** d'un flow sur des preuves :
le trafic du navigateur (en empreintes salées), l'écran final, et des **lectures d'API autorisées**
(GET seulement). Elle relie chaque résultat aux exigences qu'il vérifie.

Trois capacités, déclarées dans la mission, sans dépendance à un LLM ni à une base de données :

| Capacité              | Où                                                                                              | Ce qu'elle produit                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Assertions métier     | `flows[].assertions`                                                                            | PASS / FAIL / BLOCKED / INCONCLUSIVE / UNVERIFIABLE                                                                        |
| Cohérence des données | `flows[].consistency`                                                                           | CONSISTENT / INCONSISTENT / MISSING_DATA / AMBIGUOUS_ENTITY / NOT_OBSERVABLE / PENDING_EVENTUAL_CONSISTENCY / INCONCLUSIVE |
| Traçabilité           | `requirements`, `businessRules`, `flows[].requirements`, tags Gherkin, `x-requirements` OpenAPI | NOT_COVERED / COVERED_NOT_EXECUTED / VERIFIED_PASS / VERIFIED_FAIL / BLOCKED / INCONCLUSIVE / STALE_EVIDENCE               |

Rapports : `reports/quality-verification.json` et la section **Vérification métier** de
`index.html` (groupe « Analyse détaillée »).

## Les règles qui ne changent jamais

- **BLOCKED, INCONCLUSIVE et UNVERIFIABLE ne sont jamais un succès.** Une assertion obligatoire non
  vérifiée rend le run `INCONCLUSIVE` ; une assertion obligatoire contredite le rend `FAIL`.
- **Aucune écriture pour vérifier.** Une lecture d'API est un GET, sur un hôte que la SafetyPolicy
  autorise, avec la session du navigateur. Un 401/403 donne UNVERIFIABLE, jamais un contournement.
- **Jamais « persisté en base » sans preuve.** Le trafic observé ne montre pas le traitement côté
  serveur ; seule une lecture d'API autorisée confirme ce que le serveur renvoie. Chaque rapport
  porte cette limite (`limits`).
- **Les valeurs du run, pas les valeurs enregistrées.** `expected: { testData: request.title }` est
  la valeur générée pour CE run (TestDataRunContext) ; une donnée dont l'étape n'a pas tourné rend
  l'assertion BLOCKED, jamais comparée à un littéral.
- **Aucune valeur en clair par défaut.** Le réseau est comparé en empreintes salées ; les rapports
  montrent les clés (`testData.request.title`), des empreintes courtes et des identifiants. Avec
  `quality.showValues: true`, seules les valeurs générées et non sensibles apparaissent.
- **Un corps illisible n'est pas un corps vide.** Une réponse que la navigation a rendue illisible
  est relue par une session CDP de lecture (messages réseau durables, Chromium) ; si elle reste
  illisible, l'échange le dit (`responseUnread`) et l'assertion est INCONCLUSIVE.

## Déclarer des assertions

```yaml
flows:
  - name: create-request
    requirements: [REQ-REQUEST-CREATE]
    steps:
      - click: { role: button, name: New request }
        allow: MUTATION
      - fill: { label: Title, value: { testData: request.title } }
      - click: { role: button, name: Save }
        allow: MUTATION
      - expect: { url: /requests/ }
    assertions:
      - id: request-created
        description: The creation is accepted and returns the identifier
        criticality: CRITICAL
        after: 3 # vérifiée dès la fin de l'étape 3 (sinon : en fin de flow)
        check:
          kind: request
          method: POST
          path: /api/requests
          status: 201
          requireIdentifier: true
          extract: { name: requestId, field: id }
      - id: title-read-back
        description: An authorized read returns the title of this run
        requires: [request-created] # sinon BLOCKED
        evidence: [API] # un succès sans cette preuve est INCONCLUSIVE
        check:
          kind: value
          source: api
          api: { url: '/api/requests/${extracted:requestId}' }
          field: title
          expected: { testData: request.title }
      - id: request-open
        description: The request reaches OPEN (asynchronous processing)
        requires: [request-created]
        timeoutMs: 8000 # relue jusqu'au succès ou au délai
        pollMs: 500
        check:
          kind: state
          source: api
          api: { url: '/api/requests/${extracted:requestId}' }
          field: status
          expected: OPEN
          pending: [PENDING] # « pas encore » : INCONCLUSIVE tant que le délai court
```

Champs communs : `id` stable, `description`, `criticality` (LOW, MEDIUM, HIGH, CRITICAL),
`mandatory` (par défaut `true`), `after`, `requires`, `entities`, `timeoutMs`, `pollMs`,
`evidence` (NETWORK, DOM, API, OPENAPI).

| `kind`        | Vérifie                                                               | Sources                    |
| ------------- | --------------------------------------------------------------------- | -------------------------- |
| `request`     | une requête observée, son statut, l'identifiant retourné              | réseau                     |
| `value`       | une valeur envoyée, retournée, affichée ou relue                      | request, response, ui, api |
| `entity`      | une entité présente ou absente, unique                                | ui, api, network           |
| `state`       | un état métier (code en capitales), avec attente asynchrone           | response, api, ui          |
| `cardinality` | combien d'enregistrements portent une valeur (`equals`, `min`, `max`) | network, api               |
| `relation`    | l'entité retrouvée porte la bonne référence                           | network, api               |
| `transition`  | une transition d'état permise ou interdite                            | réseau                     |
| `sideEffects` | aucune écriture hors liste, pas de création en trop                   | réseau                     |
| `contract`    | les réponses observées sont déclarées par l'OpenAPI                   | réseau + contrat           |

Une assertion obligatoire en FAIL fait échouer le flow et produit une anomalie
`BUSINESS_ASSERTION` (CRITICAL pour une criticité CRITICAL, WARNING pour LOW ou une assertion
facultative, ERROR sinon). Les événements `BUSINESS_ASSERTION_PASSED`, `BUSINESS_ASSERTION_FAILED`
et `BUSINESS_ASSERTION_NOT_VERIFIED` vont dans `engine-log.jsonl`, avec le run, le flow, l'étape et
l'assertion.

## Cohérence des données

La donnée du run est suivie à travers le workflow : **saisie → requête → réponse → écran → recherche**.
Une valeur n'est reliée à une requête que parce que la requête la porte (empreinte), jamais par
proximité dans le temps.

| Règle                 | Ce qui est comparé                                                              |
| --------------------- | ------------------------------------------------------------------------------- |
| `UI_TO_REQUEST`       | la valeur saisie est-elle dans la requête soumise ?                             |
| `REQUEST_TO_RESPONSE` | ce qui a été envoyé est-il ce que le serveur renvoie ?                          |
| `RESPONSE_TO_UI`      | l'écran final montre-t-il la valeur du run (`displayed`) ?                      |
| `CREATE_TO_SEARCH`    | la recherche retrouve-t-elle l'entité créée, par son identifiant ?              |
| `RELATION`            | l'entité retrouvée porte-t-elle la bonne référence (`relations`) ?              |
| `DUPLICATE`           | deux enregistrements partagent-ils une clé **déclarée** unique (`uniqueKeys`) ? |
| `SIDE_EFFECT`         | écritures hors liste, créations en trop, lignes apparues dans une liste relue   |

```yaml
consistency:
  displayed: [request.title]
  transforms: { request.date: 'shown 12/03, sent 2026-03-12' } # jamais une divergence
  uniqueKeys: [{ field: number, value: { extracted: requestNumber } }]
  relations:
    - {
        id: request-owner,
        entity: { field: id, value: { extracted: requestId } },
        field: ownerId,
        expected: { value: USR-2001 },
      }
  sideEffects: { allowedWrites: [{ method: POST, path: /api/requests }], maxCreated: 1 }
  eventual: true # recherche indexée plus tard : PENDING_EVENTUAL_CONSISTENCY au lieu d'INCONSISTENT
```

Un doublon n'est jamais déduit de noms proches : seulement d'une clé déclarée unique, comparée
exactement. Plusieurs enregistrements qui portent la valeur sans identifiant de création pour
trancher donnent `AMBIGUOUS_ENTITY`. Une incohérence d'une règle déclarée (bloc `consistency`
présent) fait échouer le flow (anomalie `DATA_CONSISTENCY` ERROR) ; avec
`quality.autoConsistency: true` sans déclaration, elle reste un avertissement.

## Traçabilité

```yaml
requirements:
  - {
      id: REQ-REQUEST-CREATE,
      description: A request is created with the title typed,
      criticality: CRITICAL,
      source: TICKET-101,
    }
  - { id: REQ-REQUEST-SEARCH, description: A created request can be found, dependsOn: [REQ-REQUEST-CREATE] }
businessRules:
  - id: BR-REQUEST-OWNER
    description: A new request belongs to the default owner
    requirementIds: [REQ-REQUEST-CREATE]
    assertions: [request-owner] # VERIFIES
    derivedFrom: [POST /api/requests]
    conflictsWith: []
quality:
  evidenceMaxAgeDays: 30
  history: traceability-history.json # relatif au dossier knowledge ; false : aucun historique
```

Liens : un flow **COVERS** ses exigences (`flows[].requirements`, tags Gherkin `@REQ-12`,
`@req:12`, `@requirement:12`, `@ticket:ABC-7`), une règle **VERIFIES** une exigence par ses
assertions, une exigence **DEPENDS_ON** une autre, deux règles **CONFLICTS_WITH**, une règle
**DERIVED_FROM** une exigence, une règle ou une opération. Une opération OpenAPI qui porte
`x-requirements: [REQ-READ]` est vérifiée par les assertions `contract` qui la visent.

Une exigence citée mais non déclarée apparaît quand même (avec un avertissement). Une exigence
couverte par un flow sans assertion reste INCONCLUSIVE : un succès technique ne la vérifie pas.
L'historique garde la dernière vérification de chaque exigence ; une exigence non exécutée dont la
dernière preuve dépasse `evidenceMaxAgeDays` devient STALE_EVIDENCE. Le résumé liste à part les
exigences HIGH ou CRITICAL en échec (`criticalFailures`) : un pourcentage ne les noie jamais.

## Exemple de rapport (extrait réel)

Run de `tests/integration/business-verification.test.ts` où l'application de démonstration
enregistre un autre titre, crée deux fois et rattache un autre propriétaire. Le flow « réussit »
techniquement (7 étapes PASSED, POST → 201) ; la vérification métier le fait échouer.

```json
{
  "verdict": "FAIL",
  "requirement": {
    "id": "REQ-REQUEST-CREATE",
    "criticality": "CRITICAL",
    "source": "TICKET-101",
    "status": "VERIFIED_FAIL",
    "flows": ["create-request"],
    "rules": ["BR-REQUEST-OWNER"],
    "reasons": [
      "create-request#title-saved: FAIL",
      "create-request#title-read-back: FAIL",
      "create-request#request-owner: FAIL",
      "create-request#single-request: FAIL"
    ]
  },
  "assertion": {
    "id": "title-read-back",
    "kind": "value",
    "status": "FAIL",
    "source": "API",
    "expected": "title = testData.request.title (api)",
    "observed": "title has another value: (value not shown)",
    "reasons": ["the API returns a different value than the one submitted in this run"],
    "evidence": ["create-request#title-read-back#e4"],
    "nextStep": "compare the submitted request and the stored entity (API read) in the network report"
  },
  "consistency": {
    "rule": "REQUEST_TO_RESPONSE",
    "key": "request.title",
    "field": "title",
    "status": "INCONSISTENT",
    "declared": true,
    "sources": ["POST /api/requests → 201 (request title)", "POST /api/requests → 201 (response)"],
    "observed": "another value (#946a03fc)",
    "difference": "the server returned a different title than the one sent"
  },
  "evidence": [
    {
      "id": "create-request#title-read-back#e4",
      "type": "NETWORK",
      "sourceType": "API",
      "source": "GET /api/requests/REQ-1002 (read-only verification)",
      "confidence": 0.95,
      "runId": "mvcmsmp59101",
      "flow": "create-request",
      "assertionId": "title-read-back",
      "details": { "readOnly": true, "field": "title", "match": "differs" }
    }
  ],
  "summary": { "criticalFailures": ["REQ-REQUEST-CREATE"], "passRate": 0 }
}
```

Le statut global du run est `FAIL` (« 4 mandatory business assertion(s) failed »). Dans la même
application sans défaut, les six assertions passent, les exigences sont VERIFIED_PASS et le verdict
fonctionnel est PROVEN « by declared business assertions ».

## Ce qui ne peut pas être vérifié sans accès supplémentaire

- La persistance en base, un traitement en arrière-plan, un message envoyé à un autre système :
  seulement si une API de lecture autorisée les expose.
- Une réponse dont le corps reste illisible (navigateur autre que Chromium, corps de plus de 2 Mo) :
  INCONCLUSIVE.
- Une valeur que l'application transforme sans transformation déclarée : MISSING_DATA ou
  INCONSISTENT selon la règle, à documenter dans `transforms`.

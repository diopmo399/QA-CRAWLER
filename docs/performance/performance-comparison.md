# Performance : avant / après

> Avant : le chemin FAST/DEEP n'existait pas (les champs `path` n'apparaissent qu'après).

Banc `tests/integration/performance-benchmark.test.ts` (configuration par défaut, Chromium headless). Avant : la fenêtre de stabilité complète (400 ms) après chaque action. Après : FAST_PATH (`confirmationQuietMs: 150`) pour les étapes connues, DEEP_PATH inchangé pour le reste.

## client-context

| Mesure                                           | Avant   | Après   | Écart |
| ------------------------------------------------ | ------- | ------- | ----- |
| Somme des actions                                | 3648 ms | 2302 ms | -37 % |
| Run (navigateur compris)                         | 5185 ms | 3854 ms | -26 % |
| Médiane par action                               | 559 ms  | 321 ms  | -43 % |
| p95 par action                                   | 860 ms  | 637 ms  | -26 % |
| Attente de transition (phase)                    | 2969 ms | 1549 ms | -48 % |
| Attentes : confirmation après la dernière preuve | 2341 ms | 712 ms  | -70 % |

FAST_PATH : 7 / 7 — DEEP_PATH : 0 / 7 ; timeouts : 0 → 0

| Étape    | Avant  | Après  | Fin d'attente après                                                                                 |
| -------- | ------ | ------ | --------------------------------------------------------------------------------------------------- |
| 1 click  | 860 ms | 637 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@59, NEXT_ACTION_TARGET_AVAILABLE@59, CONDITION_CONFIRMED@168 |
| 2 fill   | 559 ms | 291 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@38, CONDITION_CONFIRMED@151                              |
| 3 check  | 519 ms | 318 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@16, CONDITION_CONFIRMED@178                              |
| 4 click  | 577 ms | 356 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@26, NEXT_ACTION_TARGET_AVAILABLE@26, CONDITION_CONFIRMED@190 |
| 5 click  | 579 ms | 379 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@37, NEXT_ACTION_TARGET_AVAILABLE@37, CONDITION_CONFIRMED@201 |
| 6 click  | 554 ms | 321 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@221, CONDITION_CONFIRMED@221                                 |
| 7 expect | 0 ms   | 0 ms   | —                                                                                                   |

## list-filter-process

| Mesure                                           | Avant   | Après   | Écart |
| ------------------------------------------------ | ------- | ------- | ----- |
| Somme des actions                                | 3772 ms | 2400 ms | -36 % |
| Run (navigateur compris)                         | 5378 ms | 4029 ms | -25 % |
| Médiane par action                               | 570 ms  | 336 ms  | -41 % |
| p95 par action                                   | 873 ms  | 639 ms  | -27 % |
| Attente de transition (phase)                    | 3157 ms | 1677 ms | -47 % |
| Attentes : confirmation après la dernière preuve | 2385 ms | 763 ms  | -68 % |

FAST_PATH : 7 / 7 — DEEP_PATH : 0 / 7 ; timeouts : 0 → 0

| Étape    | Avant  | Après  | Fin d'attente après                                                                                  |
| -------- | ------ | ------ | ---------------------------------------------------------------------------------------------------- |
| 1 click  | 873 ms | 639 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@51, NEXT_ACTION_TARGET_AVAILABLE@51, CONDITION_CONFIRMED@159  |
| 2 select | 577 ms | 336 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@49, CONDITION_CONFIRMED@161                               |
| 3 select | 570 ms | 375 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@39, CONDITION_CONFIRMED@203                               |
| 4 fill   | 534 ms | 314 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@31, CONDITION_CONFIRMED@195                               |
| 5 click  | 651 ms | 450 ms | CONDITION_MET NEXT_ACTION_TARGET_AVAILABLE@17, EXPECTED_EFFECT_OBSERVED@247, CONDITION_CONFIRMED@301 |
| 6 click  | 566 ms | 285 ms | CONDITION_MET EXPECTED_EFFECT_OBSERVED@2, CONDITION_CONFIRMED@163                                    |
| 7 expect | 1 ms   | 1 ms   | —                                                                                                    |

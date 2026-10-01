import type { FunctionalFinding } from '../functional/model.js';
import type { ActionObservations, ExecutedAction, OracleResult, SemanticOracle } from './oracle.js';
import { result } from './oracle.js';

/**
 * SEMANTIC FUNCTIONAL ORACLE : le point d'extension SemanticOracle, enfin branché. Il
 * ne regarde pas l'écran lui-même : il lit ce que l'intelligence fonctionnelle a conclu
 * de l'action (avant / après, fenêtre réseau) —
 *
 *   EXPECTED_SIDE_EFFECT_MISSING      un effet attendu n'est pas arrivé ;
 *   EXPECTED_STATE_TRANSITION_MISSING l'API a accepté, l'état affiché n'a pas changé ;
 *   EXPECTED_ENTITY_NOT_OBSERVED      une création acceptée sans entité rendue ;
 *   INVARIANT_VIOLATED                une transition partie d'un état interdit ;
 *   CONTRACT_MISMATCH                 le corps ne suit pas l'OpenAPI (le contrat peut être obsolète).
 *
 * Au plus WARNING : une attente du code non tenue n'est jamais un échec confirmé à elle seule.
 */
export class SemanticFunctionalOracle implements SemanticOracle {
  readonly name = 'functional';

  constructor(private readonly findingsOf: (actionId: string) => readonly FunctionalFinding[]) {}

  evaluate(
    _before: unknown,
    action: ExecutedAction,
    _after: unknown,
    _observations: ActionObservations,
  ): Promise<OracleResult> {
    const findings = this.findingsOf(action.id);
    const warnings = findings.filter((finding) => finding.status === 'WARNING');
    if (warnings.length > 0)
      return Promise.resolve({
        ...result(
          this.name,
          'WARNING',
          0.7,
          warnings.map((finding) => ({
            code: finding.code.toLowerCase().replace(/_/g, '-'),
            message: finding.message,
          })),
        ),
        category: warnings.every((finding) => finding.code === 'CONTRACT_MISMATCH')
          ? 'CONTRACT_VIOLATION'
          : 'UNEXPECTED_BEHAVIOR',
      });
    const passes = findings.filter((finding) => finding.status === 'PASS');
    if (passes.length > 0)
      return Promise.resolve(
        result(
          this.name,
          'PASS',
          0.8,
          passes.map((finding) => ({
            code: finding.code.toLowerCase().replace(/_/g, '-'),
            message: finding.message,
          })),
        ),
      );
    return Promise.resolve(
      result(this.name, 'UNKNOWN', 0, [
        { code: 'no-functional-expectation', message: 'no functional expectation for this action' },
      ]),
    );
  }
}

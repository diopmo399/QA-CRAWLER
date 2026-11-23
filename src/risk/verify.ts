import { createHash } from 'node:crypto';
import type { Risk, RiskStatus, RiskVerification } from '../sdk/core/risk.js';

/**
 * LA VÉRIFICATION CIBLÉE. Elle rejoue, sur les faits lus (jamais en exécutant le code de l'application), les
 * transitions qui mènent au comportement suspect : écriture, changement de contexte, lecture ; requête en
 * erreur ; émissions successives. Une simulation peut CORROBORER (le chemin est rejoué jusqu'au bout) ou
 * RÉFUTER (une transition l'interrompt) ; elle ne REPRODUIT jamais : seule une exécution réelle (test du
 * projet, déclaré avec son résultat) le peut. Quand l'attendu métier compte et n'est pas fourni, elle reste
 * INCONCLUSIVE.
 */
export function simulate(risk: Risk, input: { expected?: string }, now: Date): RiskVerification {
  const started = Date.now();
  const s = risk.scenario;
  let steps: string[] = [];
  let observed = '';
  let outcome: RiskStatus = 'INCONCLUSIVE';
  let note: string | undefined;
  if (!s) {
    observed = 'Aucune simulation n’est définie pour cette règle.';
  } else if (s.kind === 'STALE_STATE') {
    steps = [
      `${s.subject} part de sa valeur initiale.`,
      `${s.writer ?? 'L’écrivain'} écrit une valeur A (parcours 1).`,
      'Changement de contexte : le service qui garde la donnée n’est pas recréé (portée lue dans le code).',
      `${s.reader ?? 'Le lecteur'} s’initialise (parcours 2) et lit ${s.subject} sans l’écrire avant.`,
    ];
    if (s.readerWritesFirst) {
      observed = `${s.reader ?? 'Le lecteur'} écrit la donnée avant de la lire : la valeur A n’est pas lue.`;
      outcome = 'REFUTED';
    } else {
      observed = `${s.reader ?? 'Le lecteur'} reçoit la valeur A écrite par ${s.writer ?? 'le parcours précédent'}.`;
      if (input.expected) {
        outcome = 'CORROBORATED';
        note = `Attendu déclaré : ${input.expected}. La persistance observée le contredit dans le modèle rejoué ; seule l’exécution d’un test du projet peut le reproduire.`;
      } else {
        note =
          'L’attendu métier est inconnu (la persistance peut être voulue) : résultat inconclusif. Fournir l’attendu pour conclure.';
      }
    }
  } else if (s.kind === 'LOADING_FLAG') {
    const member = s.subject.split('.').pop() ?? s.subject;
    steps = [
      `${s.trigger ?? ''} pose ${member} à vrai.`,
      'La requête répond par une erreur.',
      'La suite de succès n’est pas exécutée.',
      `Aucune suite d’erreur, finalize ni finally ne remet ${member}.`,
    ];
    observed = `${s.subject} reste vrai après l’erreur.`;
    outcome = 'CORROBORATED';
    note =
      'Attendu technique : un indicateur de requête en cours revient à faux quand la requête se termine, en succès comme en erreur.';
  } else if (s.kind === 'BROKEN_CHAIN') {
    steps = [
      `Émission 1 sur ${s.source ?? 'la source'} : ${s.trigger ?? 'l’aplatissement'} lance la requête.`,
      'La requête répond par une erreur, non rattrapée dans le flux interne.',
      `L’erreur traverse ${s.trigger ?? 'l’opérateur'} : ${s.subject} est terminé.`,
      `Émission 2 sur ${s.source ?? 'la source'} : plus aucun abonnement actif, rien n’est traité.`,
    ];
    observed = `Après une erreur, ${s.subject} ne traite plus aucune émission.`;
    outcome = 'CORROBORATED';
    note = 'Comportement défini par RxJS : une notification d’erreur termine le flux.';
  } else if (s.kind === 'SUBSCRIPTION_LEAK') {
    steps = [
      `${s.subject} souscrit ${s.source ?? 'la source'}.`,
      'Le composant est détruit ; aucun mécanisme ne termine la souscription.',
      `${s.source ?? 'La source'} émet : le rappel du composant détruit s’exécute.`,
    ];
    observed = 'Le rappel s’exécute après la destruction du composant.';
    outcome = 'CORROBORATED';
  } else {
    // STALE_RESPONSE
    steps = [
      `Déclenchement 1 (${s.trigger ?? ''}) : requête R1.`,
      'Déclenchement 2 : requête R2, sans annuler R1.',
      `R2 répond : ${s.subject} = réponse de R2.`,
      `R1 répond ensuite : ${s.subject} = réponse de R1 (plus ancienne).`,
    ];
    observed = `${s.subject} garde la réponse la plus ancienne quand les réponses arrivent dans le désordre.`;
    outcome = 'CORROBORATED';
    note = 'L’ordre d’arrivée dépend du réseau : le modèle rejoue le cas défavorable.';
  }
  return {
    id: `V-${createHash('sha256').update(`${risk.id}|${now.toISOString()}|${outcome}`).digest('hex').slice(0, 12)}`,
    at: now.toISOString(),
    method: 'STATE_SIMULATION',
    outcome,
    steps,
    observed,
    ...(input.expected ? { expected: input.expected } : {}),
    ...(note ? { note } : {}),
    durationMs: Date.now() - started,
    fingerprint: risk.fingerprint,
  };
}

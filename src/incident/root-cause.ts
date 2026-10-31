import {
  DYNAMIC_EXPERIMENTS,
  meetsConfirmation,
  recommendationsFor,
  supportingExperiments,
} from './hypotheses.js';
import type { CodeIndex, Diagnosis, Experiment, Hypothesis, ReproductionRun } from './model.js';

/**
 * LA CAUSE RACINE : CONFIRMED seulement à partir d'une hypothèse CONFIRMED (et qui le reste au
 * regard des preuves), PROBABLE à partir de la meilleure hypothèse SUPPORTED, sinon INCONCLUSIVE
 * avec ce qui manque pour conclure. Les recommandations viennent des hypothèses, jamais d'ailleurs.
 */

const byConfidence = (left: Hypothesis, right: Hypothesis): number =>
  right.confidence - left.confidence || left.id.localeCompare(right.id);

function missingFor(input: {
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  reproduction?: ReproductionRun;
  code?: CodeIndex;
}): string[] {
  const { hypotheses, experiments, reproduction, code } = input;
  const missing: string[] = [];
  if (!reproduction) missing.push('Aucune reproduction : le symptôme n’a pas été observé par QA-CRAWLER.');
  else if (reproduction.reproduced === false)
    missing.push(`Symptôme non reproduit (${reproduction.symptomMatch ?? 'aucune correspondance'}).`);
  else if (reproduction.reproduced === null)
    missing.push(`La reproduction n’a pas abouti${reproduction.error ? ` (${reproduction.error})` : ''}.`);
  if (reproduction && !reproduction.requests.some((request) => request.responseBody !== undefined))
    missing.push(
      'Aucun corps de réponse capturé (network.captureBodies désactivé ?) : l’erreur serveur n’est pas lisible.',
    );
  if (!code) missing.push('Code non analysé (lecture des sources non autorisée ou non lancée).');
  else {
    if (code.truncated.length > 0) missing.push(`Analyse du code partielle : ${code.truncated.join(' ; ')}.`);
    if (code.denied.length > 0)
      missing.push(
        `${String(code.denied.length)} chemin(s) refusé(s) par le périmètre (extension à demander).`,
      );
  }
  const live = hypotheses.filter((hypothesis) => hypothesis.status !== 'REFUTED');
  if (hypotheses.length === 0) missing.push('Aucune hypothèse fondée sur les preuves disponibles.');
  else if (live.length === 0)
    missing.push('Toutes les hypothèses ont été réfutées : de nouvelles preuves sont nécessaires.');
  const done = experiments.filter((experiment) => experiment.status === 'DONE');
  if (done.length === 0) missing.push('Aucune vérification exécutée.');
  for (const experiment of experiments.filter((item) => item.status === 'REFUSED'))
    missing.push(
      `Vérification ${experiment.kind} refusée : ${
        experiment.decisions.find((decision) => !decision.allowed)?.reason ??
        experiment.summary ??
        'refus du périmètre'
      }`.replace(/\.*$/, '.'),
    );
  for (const experiment of experiments.filter((item) => item.status === 'APPROVAL_REQUIRED'))
    missing.push(`Vérification ${experiment.kind} en attente d’approbation (effets de bord).`);
  return missing;
}

/** Ce qu'il manque à une hypothèse SUPPORTED pour être confirmée. */
function confirmationGap(hypothesis: Hypothesis): string[] {
  const supports = supportingExperiments(hypothesis);
  const kinds = [...new Set(supports.map((item) => item.kind))];
  const gap: string[] = [];
  if (hypothesis.contradicting.length > 0)
    gap.push(
      `${hypothesis.id} a des preuves contraires : ${hypothesis.contradicting.map((item) => item.fact).join(' ; ')}.`,
    );
  if (kinds.length < 2)
    gap.push(
      `${hypothesis.id} n’est soutenue que par ${kinds.length === 0 ? 'aucune vérification' : kinds.join(', ')} : une seconde vérification d’une autre sorte est nécessaire.`,
    );
  if (!supports.some((item) => DYNAMIC_EXPERIMENTS.includes(item.kind)))
    gap.push(`${hypothesis.id} n’a aucune vérification dynamique (rejeu, comparaison, test, journaux).`);
  return gap;
}

export function diagnose(
  input: {
    hypotheses: Hypothesis[];
    experiments: Experiment[];
    reproduction?: ReproductionRun;
    code?: CodeIndex;
  },
  now: Date,
): Diagnosis {
  const { hypotheses } = input;
  const live = hypotheses.filter((hypothesis) => hypothesis.status !== 'REFUTED').sort(byConfidence);
  // Une hypothèse marquée CONFIRMED doit encore satisfaire le seuil de preuves.
  const confirmed = live.find(
    (hypothesis) => hypothesis.status === 'CONFIRMED' && meetsConfirmation(hypothesis),
  );
  const supported = live.find(
    (hypothesis) => hypothesis.status === 'SUPPORTED' || hypothesis.status === 'CONFIRMED',
  );
  const root = confirmed ?? supported;
  const status: Diagnosis['status'] = confirmed ? 'CONFIRMED' : supported ? 'PROBABLE' : 'INCONCLUSIVE';

  const alternatives = live
    .filter((hypothesis) => hypothesis.id !== root?.id)
    .map((hypothesis) => ({
      hypothesisId: hypothesis.id,
      statement: hypothesis.suspectedCause,
      confidence: hypothesis.confidence,
    }));

  const missing =
    status === 'CONFIRMED'
      ? []
      : [...(root ? confirmationGap(root) : []), ...missingFor(input)].filter(
          (item, index, all) => all.indexOf(item) === index,
        );

  const recommendations: string[] = [];
  if (root) recommendations.push(...recommendationsFor(root));
  // Les causes complémentaires soutenues (validation manquante ET déréférencement, par exemple).
  for (const other of live.filter(
    (hypothesis) =>
      hypothesis.id !== root?.id && (hypothesis.status === 'SUPPORTED' || hypothesis.status === 'CONFIRMED'),
  ))
    recommendations.push(...recommendationsFor(other));
  if (status !== 'CONFIRMED') {
    const next = (root ? [root] : live.slice(0, 2)).flatMap((hypothesis) =>
      hypothesis.verifications.map(
        (verification) => `${verification.kind} (${hypothesis.id}) : ${verification.description}`,
      ),
    );
    if (next.length > 0) recommendations.push(`Vérifications à exécuter : ${next.slice(0, 4).join(' ; ')}.`);
  }
  if (input.reproduction?.reproduced === true)
    recommendations.push('Ajouter le test de non-régression proposé une fois la correction faite.');

  return {
    status,
    ...(root
      ? {
          rootCause: {
            hypothesisId: root.id,
            statement: root.suspectedCause,
            layer: root.layer,
            files: root.files,
          },
        }
      : {}),
    alternatives,
    missing,
    recommendations: [...new Set(recommendations)],
    generatedAt: now.toISOString(),
  };
}

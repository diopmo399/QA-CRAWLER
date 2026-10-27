/**
 * LES PHASES DU MOTEUR (événements `phase`) dans la langue du composant. Le moteur les annonce en
 * anglais (RUN_PHASES, EXPLORER_CLOSING_PHASES, RECORDING_PHASES) ; une phase inconnue s'affiche telle
 * quelle. tests/unit/sdk-engine-phases.test.ts vérifie que chaque phase du moteur est traduite.
 */
const FR: Record<string, string> = {
  'Finishing the run': 'Fin du run',
  'Closing the run': 'Clôture du run',
  'Checking the other actors': 'Vérification des autres acteurs',
  'Comparing with earlier runs': 'Comparaison avec les runs précédents',
  'Saving the knowledge': 'Enregistrement des connaissances',
  'Writing the artifacts': 'Écriture des artefacts',
  'Saving the baseline': 'Enregistrement de la référence',
  'Writing the reports': 'Écriture des rapports',
  'Waiting for open tabs and downloads': 'Attente des onglets et téléchargements ouverts',
  'Closing the browser': 'Fermeture du navigateur',
  'Stopping the intelligence client': 'Arrêt du client d’intelligence',
  'Saving the memory': 'Enregistrement de la mémoire',
  'Running the API tests': 'Tests d’API',
  'Finishing the capture': 'Fin de la capture',
  'Building the flow': 'Construction du flow',
  'Writing the files': 'Écriture des fichiers',
  'Auditing the flow': 'Audit du flow',
  'Validating by replay': 'Validation par rejeu',
  'Writing the report': 'Écriture du rapport',
  'cancellation requested': 'Annulation demandée',
};

export function enginePhase(phase: string, locale: 'fr' | 'en'): string {
  return locale === 'fr' ? (FR[phase] ?? phase) : phase;
}

/** Les phases traduites (tests). */
export const TRANSLATED_ENGINE_PHASES = Object.keys(FR);

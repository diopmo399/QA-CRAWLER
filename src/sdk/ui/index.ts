/**
 * @qa-crawler/core/sdk/ui — l'élément <qa-crawler-project-wizard>, défini à l'import.
 */
import { defineWizard } from './wizard.js';

export { QaCrawlerProjectWizard, defineWizard } from './wizard.js';
export { strings, type Locale, type Strings } from './i18n.js';
export { WIZARD_CSS } from './styles.js';

defineWizard();

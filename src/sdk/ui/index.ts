/**
 * @qa-crawler/core/sdk/ui — l'élément <qa-crawler-project-wizard>, défini à l'import.
 */
import { defineStudio } from './studio.js';
import { defineWizard } from './wizard.js';

export { QaCrawlerProjectWizard, defineWizard } from './wizard.js';
export { strings, type Locale, type Strings } from './i18n.js';
export { WIZARD_CSS } from './styles.js';
export { QaCrawlerFlowStudio, defineStudio } from './studio.js';
export { studioStrings, type StudioStrings } from './studio-i18n.js';
export { STUDIO_CSS } from './studio-styles.js';
export { layoutStudio, searchStudio, fitView, type StudioLayout } from './studio-layout.js';

defineWizard();
defineStudio();

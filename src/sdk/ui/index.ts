/**
 * @qa-crawler/core/sdk/ui — les éléments <qa-crawler-project-wizard>, <qa-crawler-flow-studio> et
 * <qa-crawler-run-compare>, définis à l'import.
 */
import { defineRunCompare } from './runs.js';
import { defineStudio } from './studio.js';
import { defineWizard } from './wizard.js';

export { QaCrawlerProjectWizard, defineWizard } from './wizard.js';
export { strings, type Locale, type Strings } from './i18n.js';
export { WIZARD_CSS } from './styles.js';
export { QaCrawlerFlowStudio, defineStudio } from './studio.js';
export { studioStrings, type StudioStrings } from './studio-i18n.js';
export { STUDIO_CSS } from './studio-styles.js';
export { layoutStudio, searchStudio, fitView, type StudioLayout } from './studio-layout.js';

export { QaCrawlerRunCompare, defineRunCompare } from './runs.js';
export { runsStrings, type RunsStrings } from './runs-i18n.js';
export { RUNS_CSS } from './runs-styles.js';

defineWizard();
defineStudio();
defineRunCompare();

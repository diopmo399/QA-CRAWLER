/**
 * Identité de l'outil qui produit un run : version du cœur (@qa-crawler/core), version du CLI
 * (@qa-crawler/cli, quand le run passe par lui), version du projet analysé (son package.json) et
 * version de Node. Le CLI et la commande de projet la renseignent ; l'orchestrateur la copie dans
 * chaque résultat (`result.tool`) pour que deux rapports soient toujours comparables.
 */
import { readFile } from 'node:fs/promises';

export interface ToolIdentity {
  /** Version de @qa-crawler/core (ou du dépôt quand on exécute depuis les sources). */
  coreVersion: string;
  /** Version de @qa-crawler/cli, absente quand le cœur est appelé directement. */
  cliVersion?: string;
  /** Version du projet analysé (package.json du projet utilisateur), absente hors projet. */
  projectVersion?: string;
  /** `process.version`. */
  node: string;
}

let overrides: Partial<ToolIdentity> = {};

/** Déclare la version du CLI et/ou du projet pour les runs qui suivent dans ce processus. */
export function setToolIdentity(values: Partial<Pick<ToolIdentity, 'cliVersion' | 'projectVersion'>>): void {
  overrides = { ...overrides, ...values };
}

/** Version du cœur lue dans le package.json du paquet (dist) ou du dépôt (sources). */
export async function readCoreVersion(): Promise<string> {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(await readFile(new URL(candidate, import.meta.url), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && (pkg.name === '@qa-crawler/core' || pkg.name === 'qa-crawler-monorepo'))
        return pkg.version;
    } catch {
      // le candidat suivant
    }
  }
  return 'unknown';
}

export async function toolIdentity(): Promise<ToolIdentity> {
  return {
    coreVersion: await readCoreVersion(),
    ...(overrides.cliVersion ? { cliVersion: overrides.cliVersion } : {}),
    ...(overrides.projectVersion ? { projectVersion: overrides.projectVersion } : {}),
    node: process.version,
  };
}

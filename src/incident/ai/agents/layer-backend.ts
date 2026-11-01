import type { InvestigationAgent } from '../agent.js';
import { BACKEND_SYSTEM_PROMPT } from '../prompts/backend.js';
import type { LayerFindings } from '../schemas/layer.js';
import type { JavaLayerAgentDefinition, JavaLayerAgentOptions } from './layer-java.js';
import { createJavaLayerAgent } from './layer-java.js';

/**
 * L'AGENT BACKEND (Spring Boot) : controllers, services, dépôts, entités, DTO, validations, transactions,
 * exceptions, configuration, SQL déclaré ; cherche la NullPointerException, la validation absente, la contrainte
 * de base violée, l'écart de mapping, l'exception non gérée, la transaction mal bornée, la condition métier non
 * remplie, l'écart DTO ↔ entité. Lecture seule ; ses vérifications ne sont que des indices (`hypothesisHint`).
 */
export const BACKEND_AGENT: JavaLayerAgentDefinition = {
  name: 'BACKEND',
  layer: 'BACKEND',
  system: BACKEND_SYSTEM_PROMPT,
  task: 'Start from the backend endpoint called by the BFF, or from the class and method named in the exception message; follow controller -> service -> repository -> entity and compare the observed request body with what the code requires.',
};

export function createBackendAgent(options: JavaLayerAgentOptions = {}): InvestigationAgent<LayerFindings> {
  return createJavaLayerAgent(BACKEND_AGENT, options);
}

/** L'agent avec ses réglages par défaut. */
export const backendAgent: InvestigationAgent<LayerFindings> = createBackendAgent();

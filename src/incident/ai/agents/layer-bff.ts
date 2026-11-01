import type { InvestigationAgent } from '../agent.js';
import { BFF_SYSTEM_PROMPT } from '../prompts/bff.js';
import type { LayerFindings } from '../schemas/layer.js';
import type { JavaLayerAgentDefinition, JavaLayerAgentOptions } from './layer-java.js';
import { createJavaLayerAgent } from './layer-java.js';

/**
 * L'AGENT BFF : controllers, services, DTO, mappers, clients HTTP, gestion des exceptions, validations,
 * propagation des statuts ; cherche l'écart de contrat Frontend ↔ Backend, les champs perdus, la validation
 * absente, la mauvaise propagation d'exception ou de statut, la configuration du client. Lecture seule ;
 * ses vérifications ne sont que des indices (`hypothesisHint`) pour l'agent de planification.
 */
export const BFF_AGENT: JavaLayerAgentDefinition = {
  name: 'BFF',
  layer: 'BFF',
  system: BFF_SYSTEM_PROMPT,
  task: 'Follow the chain from the failing request to the backend call: compare what the frontend sent with what the BFF validates, maps and forwards, and how the backend error is propagated back.',
};

export function createBffAgent(options: JavaLayerAgentOptions = {}): InvestigationAgent<LayerFindings> {
  return createJavaLayerAgent(BFF_AGENT, options);
}

/** L'agent avec ses réglages par défaut. */
export const bffAgent: InvestigationAgent<LayerFindings> = createBffAgent();

import {
  SUPPORTED_TECHNOLOGIES,
  type MapTechnology,
  type TechnologyStatus,
} from '../sdk/core/cartography.js';
import type { ReadFile } from './files.js';

/**
 * LA DÉTECTION DES TECHNOLOGIES d'une source, par signaux déterministes (manifestes, imports, annotations,
 * fichiers) : jamais une supposition. Une technologie détectée sans analyseur est dite « connecteur
 * manquant » ; elle n'est ni analysée ni comptée comme vide.
 */
const json = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Un document OpenAPI ou Swagger (JSON ou YAML). */
export function isOpenApi(file: ReadFile): boolean {
  if (/\.json$/i.test(file.path)) {
    const doc = json(file.text);
    return doc !== undefined && (typeof doc.openapi === 'string' || typeof doc.swagger === 'string');
  }
  if (/\.ya?ml$/i.test(file.path)) return /^(openapi|swagger)\s*:\s*['"]?\d/m.test(file.text);
  return false;
}

export function detectTechnologies(files: readonly ReadFile[]): Set<MapTechnology> {
  const found = new Set<MapTechnology>();
  for (const file of files) {
    const name = file.path.split('/').pop() ?? file.path;
    if (name === 'package.json') {
      const manifest = json(file.text);
      const deps = {
        ...((manifest?.dependencies as Record<string, string> | undefined) ?? {}),
        ...((manifest?.devDependencies as Record<string, string> | undefined) ?? {}),
      };
      if (deps['@angular/core']) found.add('ANGULAR');
      if (deps.react) found.add('REACT');
      if (deps.vue) found.add('VUE');
      if (deps.express || deps['@nestjs/core'] || deps.fastify || deps.koa) found.add('NODE');
      if (deps.graphql || deps['@apollo/server'] || deps['@apollo/client']) found.add('GRAPHQL');
      if (deps.kafkajs || deps.amqplib) found.add('EVENTS');
    } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
      if (file.text.includes('@angular/core')) found.add('ANGULAR');
      else if (/from ['"]react['"]/.test(file.text)) found.add('REACT');
      else if (/from ['"]vue['"]/.test(file.text)) found.add('VUE');
    } else if (name.endsWith('.vue')) found.add('VUE');
    else if (/\.(java|kt)$/.test(name)) {
      if (
        /@(RestController|Controller|RequestMapping|GetMapping|PostMapping|Service|SpringBootApplication)\b/.test(
          file.text,
        )
      )
        found.add('SPRING');
      if (/@(Entity|Table)\b/.test(file.text) && /(jakarta|javax)\.persistence/.test(file.text))
        found.add('JPA');
      if (/@(KafkaListener|RabbitListener|JmsListener)\b|KafkaTemplate|RabbitTemplate/.test(file.text))
        found.add('EVENTS');
    } else if (/^(pom\.xml|build\.gradle(\.kts)?)$/.test(name)) {
      if (file.text.includes('spring-boot') || file.text.includes('org.springframework')) found.add('SPRING');
    } else if (/\.(cs|csproj)$/.test(name)) found.add('DOTNET');
    else if (/\.(graphql|gql)$/.test(name)) found.add('GRAPHQL');
    else if (name.endsWith('.sql')) found.add('SQL');
    if (/\.(json|ya?ml)$/i.test(name) && isOpenApi(file)) found.add('OPENAPI');
  }
  return found;
}

/** L'état de chaque technologie détectée : analysée, ou connecteur manquant. */
export function technologyStatuses(found: ReadonlySet<MapTechnology>): TechnologyStatus[] {
  return [...found].sort().map((technology) => {
    const supported = SUPPORTED_TECHNOLOGIES.includes(technology);
    return {
      technology,
      detected: true,
      supported,
      analyzed: supported,
      ...(supported
        ? {}
        : { note: `connecteur manquant : ${technology} n’est pas analysé (rien n’est déduit)` }),
    };
  });
}

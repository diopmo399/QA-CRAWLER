import path from 'node:path';
import type { ReadFile } from './files.js';
import type { MavenDependency, MavenFacts, MavenGeneration, MavenModule } from './facts.js';

/**
 * LES MODULES MAVEN d'une source, lus dans leurs pom.xml (jamais exécutés, aucun téléchargement) : identité,
 * parent, modules, propriétés, dépendances (versions gérées comprises), profils, et les plugins qui génèrent
 * du code à partir d'un contrat (openapi-generator, swagger-codegen) ou un contrat à partir du code
 * (springdoc). Les propriétés `${…}` sont remplacées quand leur valeur est écrite dans le module, ses parents
 * de la même source, ou est une propriété du projet ; sinon elles restent telles quelles et sont listées.
 */
interface El {
  name: string;
  children: El[];
  text: string;
  line: number;
}

/** Un lecteur XML minimal et tolérant : éléments, texte, commentaires, CDATA, déclarations ignorées. */
export function parseXml(text: string): El | undefined {
  const root: El = { name: '#root', children: [], text: '', line: 1 };
  const stack: El[] = [root];
  let i = 0;
  let line = 1;
  const advance = (to: number): void => {
    for (let k = i; k < to; k += 1) if (text.charCodeAt(k) === 10) line += 1;
    i = to;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1] ?? root;
    if (lt < 0) break;
    if (lt > i) top.text += text.slice(i, lt);
    advance(lt);
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      advance(end < 0 ? text.length : end + 3);
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      top.text += text.slice(i + 9, end < 0 ? text.length : end);
      advance(end < 0 ? text.length : end + 3);
    } else if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      advance(end < 0 ? text.length : end + 1);
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      const name = text.slice(i + 2, end).trim();
      // Une balise fermante sans ouvrante correspondante est ignorée (document mal formé).
      const at = stack.map((el) => el.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      advance(end < 0 ? text.length : end + 1);
    } else {
      const end = text.indexOf('>', i);
      if (end < 0) break;
      const raw = text.slice(i + 1, end);
      const selfClosing = raw.endsWith('/');
      const name = raw.replace(/\/$/, '').trim().split(/\s+/)[0] ?? '';
      const el: El = { name, children: [], text: '', line };
      top.children.push(el);
      advance(end + 1);
      if (!selfClosing) stack.push(el);
    }
  }
  return root.children.find((el) => el.name === 'project');
}

const child = (el: El | undefined, name: string): El | undefined => el?.children.find((c) => c.name === name);
const children = (el: El | undefined, name: string): El[] =>
  el?.children.filter((c) => c.name === name) ?? [];
const value = (el: El | undefined, name: string): string | undefined => {
  const text = child(el, name)?.text.trim();
  return text ? text : undefined;
};
const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Le préfixe interne d'un chemin ancré à la racine de la source (jamais écrit dans un pom). */
const ROOT = '\u0000root/';

/** Un chemin du pom rapporté à la racine de la source : ancré tel quel, sinon relatif au module. */
const anchor = (p: string, dir: string): string =>
  p.startsWith(ROOT)
    ? path.posix.normalize(p.slice(ROOT.length).replace(/^\/+/, '') || '.')
    : path.posix.normalize(path.posix.join(dir || '.', p));
/** Le texte d'un chemin pour l'affichage (sans le marqueur interne). */
const shown = (p: string): string => p.split(ROOT).join('');

const GENERATORS: Record<string, MavenGeneration['plugin']> = {
  'openapi-generator-maven-plugin': 'openapi-generator',
  'swagger-codegen-maven-plugin': 'swagger-codegen',
  'springdoc-openapi-maven-plugin': 'springdoc',
};

interface Draft {
  module: MavenModule;
  project: El;
  dir: string;
}

export function analyzeMaven(files: readonly ReadFile[]): MavenFacts {
  const warnings: string[] = [];
  const drafts: Draft[] = [];
  for (const file of files.filter((f) => path.posix.basename(f.path) === 'pom.xml')) {
    const project = parseXml(file.text);
    const artifactId = project ? value(project, 'artifactId') : undefined;
    if (!project || !artifactId) {
      warnings.push(`unreadable pom.xml: ${file.path}`);
      continue;
    }
    const parentEl = child(project, 'parent');
    const parentId = value(parentEl, 'artifactId');
    const props = child(project, 'properties');
    drafts.push({
      project,
      dir: path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path),
      module: {
        file: file.path,
        ...(value(project, 'groupId') ? { groupId: value(project, 'groupId') } : {}),
        artifactId,
        ...(value(project, 'version') ? { version: value(project, 'version') } : {}),
        ...(value(project, 'packaging') ? { packaging: value(project, 'packaging') } : {}),
        ...(parentId
          ? {
              parent: {
                artifactId: parentId,
                ...(value(parentEl, 'groupId') ? { groupId: value(parentEl, 'groupId') } : {}),
                ...(value(parentEl, 'version') ? { version: value(parentEl, 'version') } : {}),
                ...(value(parentEl, 'relativePath') !== undefined
                  ? { relativePath: value(parentEl, 'relativePath') }
                  : {}),
              },
            }
          : {}),
        modules: children(child(project, 'modules'), 'module').map((m) => m.text.trim()),
        properties: Object.fromEntries((props?.children ?? []).map((p) => [p.name, decode(p.text.trim())])),
        dependencies: [],
        managed: [],
        profiles: children(child(project, 'profiles'), 'profile').flatMap((p) => value(p, 'id') ?? []),
        generations: [],
        sourceDirs: [],
        unresolved: [],
      },
    });
  }
  const byFile = new Map(drafts.map((d) => [d.module.file, d]));
  /** Le parent d'un module dans la même source : relativePath (défaut ../pom.xml), sinon par identité. */
  const parentOf = (d: Draft): Draft | undefined => {
    const parent = d.module.parent;
    if (!parent) return undefined;
    const rel = parent.relativePath ?? '../pom.xml';
    if (rel) {
      const target = path.posix.normalize(
        path.posix.join(d.dir || '.', rel.endsWith('.xml') ? rel : `${rel}/pom.xml`),
      );
      const found = byFile.get(target);
      if (found?.module.artifactId === parent.artifactId) return found;
    }
    return drafts.find(
      (x) =>
        x !== d &&
        x.module.artifactId === parent.artifactId &&
        (!parent.groupId || groupOf(x) === parent.groupId),
    );
  };
  const groupOf = (d: Draft): string | undefined => d.module.groupId ?? d.module.parent?.groupId;
  const chain = (d: Draft): Draft[] => {
    const out: Draft[] = [];
    for (let cur: Draft | undefined = d; cur && !out.includes(cur) && out.length < 10; cur = parentOf(cur))
      out.push(cur);
    return out;
  };

  for (const d of drafts) {
    const lineage = chain(d);
    const missing = new Set<string>();
    const builtins: Record<string, string> = {
      // Un chemin ancré au module : marqué pour ne pas être joint une seconde fois à son dossier.
      'project.basedir': `${ROOT}${d.dir}`,
      basedir: `${ROOT}${d.dir}`,
      'project.build.directory': `${ROOT}${path.posix.join(d.dir || '.', 'target')}`,
      'project.artifactId': d.module.artifactId,
    };
    const version = d.module.version ?? d.module.parent?.version;
    const group = groupOf(d);
    if (version) builtins['project.version'] = version;
    if (group) builtins['project.groupId'] = group;
    if (d.module.parent?.version) builtins['project.parent.version'] = d.module.parent.version;
    const lookup = (name: string): string | undefined => {
      if (name in builtins) return builtins[name];
      for (const x of lineage) if (name in x.module.properties) return x.module.properties[name];
      return undefined;
    };
    const resolve = (text: string | undefined, depth = 0): string | undefined => {
      if (text === undefined) return undefined;
      return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
        const found = depth < 8 ? lookup(name) : undefined;
        if (found === undefined) {
          missing.add(name);
          return whole;
        }
        return resolve(found, depth + 1) ?? whole;
      });
    };
    const m = d.module;
    // Identité effective : hérite du parent ce que le module ne déclare pas (comme Maven).
    if (group) m.groupId = resolve(group);
    if (version) m.version = resolve(version);
    if (m.parent?.version) m.parent.version = resolve(m.parent.version);
    const depOf = (el: El): MavenDependency | undefined => {
      const artifactId = resolve(value(el, 'artifactId'));
      if (!artifactId) return undefined;
      const groupId = resolve(value(el, 'groupId'));
      const version = resolve(value(el, 'version'));
      const scope = value(el, 'scope');
      return {
        ...(groupId ? { groupId } : {}),
        artifactId,
        ...(version ? { version } : {}),
        ...(scope ? { scope } : {}),
        line: el.line,
      };
    };
    m.managed = children(
      child(child(d.project, 'dependencyManagement'), 'dependencies'),
      'dependency',
    ).flatMap((el) => depOf(el) ?? []);
    // La version d'une dépendance sans version : gérée par ce module ou un parent de la même source.
    const managedVersion = (dep: MavenDependency): string | undefined => {
      for (const x of lineage) {
        const own = x === d ? m.managed : x.module.managed;
        const hit = own.find(
          (e) => e.artifactId === dep.artifactId && (!dep.groupId || e.groupId === dep.groupId),
        );
        if (hit?.version) return hit.version;
      }
      return undefined;
    };
    const profileEls = children(child(d.project, 'profiles'), 'profile');
    const scopes: { el: El | undefined; profile?: string }[] = [
      { el: d.project },
      ...profileEls.map((p) => ({ el: p, ...(value(p, 'id') ? { profile: value(p, 'id') } : {}) })),
    ];
    for (const scope of scopes) {
      for (const el of children(child(scope.el, 'dependencies'), 'dependency')) {
        const dep = depOf(el);
        if (!dep) continue;
        if (!dep.version) {
          const managed = managedVersion(dep);
          if (managed) Object.assign(dep, { version: managed, managed: true });
        }
        m.dependencies.push(dep);
      }
      const plugins = [
        ...children(child(child(scope.el, 'build'), 'plugins'), 'plugin'),
        ...children(child(child(child(scope.el, 'build'), 'pluginManagement'), 'plugins'), 'plugin'),
      ];
      // Les artefacts dépaquetés par maven-dependency-plugin (un contrat lu depuis un module dépendant).
      const unpacks: { artifact: string; dir: string }[] = [];
      for (const plugin of plugins.filter((p) => value(p, 'artifactId') === 'maven-dependency-plugin'))
        for (const exec of [plugin, ...children(child(plugin, 'executions'), 'execution')]) {
          const conf = child(exec, 'configuration');
          const out = resolve(value(conf, 'outputDirectory'));
          for (const item of children(child(conf, 'artifactItems'), 'artifactItem')) {
            const a = resolve(value(item, 'artifactId'));
            const dir = resolve(value(item, 'outputDirectory')) ?? out;
            if (a && dir) unpacks.push({ artifact: a, dir: anchor(dir, d.dir) });
          }
        }
      for (const plugin of plugins.filter((p) => value(p, 'artifactId') === 'build-helper-maven-plugin'))
        for (const exec of children(child(plugin, 'executions'), 'execution'))
          for (const src of children(child(child(exec, 'configuration'), 'sources'), 'source')) {
            const dir = resolve(src.text.trim());
            if (dir) m.sourceDirs.push(anchor(dir, d.dir));
          }
      for (const plugin of plugins) {
        const kind = GENERATORS[value(plugin, 'artifactId') ?? ''];
        if (!kind) continue;
        const pluginConf = child(plugin, 'configuration');
        // Les artefacts ajoutés au classpath du plugin : un inputSpec relatif peut y être une ressource.
        const pluginDeps = children(child(plugin, 'dependencies'), 'dependency').flatMap(
          (el) => resolve(value(el, 'artifactId')) ?? [],
        );
        const executions = children(child(plugin, 'executions'), 'execution');
        for (const exec of executions.length ? executions : [plugin]) {
          const conf = child(exec, 'configuration');
          const get = (name: string): string | undefined =>
            resolve(value(conf, name) ?? value(pluginConf, name));
          const option = (name: string): string | undefined =>
            resolve(
              value(child(conf, 'configOptions'), name) ?? value(child(pluginConf, 'configOptions'), name),
            );
          const bool = (text: string | undefined): boolean | undefined =>
            text === 'true' ? true : text === 'false' ? false : undefined;
          const inputSpec = get('inputSpec');
          const generation: MavenGeneration = {
            plugin: kind,
            ...(exec !== plugin && value(exec, 'id') ? { execution: value(exec, 'id') } : {}),
            ...((get('generatorName') ?? get('language'))
              ? { generator: get('generatorName') ?? get('language') }
              : {}),
            ...(get('library') ? { library: get('library') } : {}),
            ...(inputSpec ? { inputSpec: shown(inputSpec) } : {}),
            ...(get('apiPackage') ? { apiPackage: get('apiPackage') } : {}),
            ...(get('modelPackage') ? { modelPackage: get('modelPackage') } : {}),
            ...(bool(option('interfaceOnly') ?? get('interfaceOnly')) !== undefined
              ? { interfaceOnly: bool(option('interfaceOnly') ?? get('interfaceOnly')) }
              : {}),
            ...(bool(option('useTags')) !== undefined ? { useTags: bool(option('useTags')) } : {}),
            ...(scope.profile ? { profile: scope.profile } : {}),
            line: exec.line,
          };
          if (inputSpec && kind !== 'springdoc')
            generation.spec = specOf(inputSpec, d.dir, files, unpacks, pluginDeps);
          m.generations.push(generation);
        }
      }
    }
    m.unresolved = [...missing].sort();
  }
  return { modules: drafts.map((d) => d.module), warnings };
}

/**
 * Où est le contrat d'entrée d'une génération : un fichier de la source (chemin du module ou de la racine),
 * une ressource d'un artefact dépaqueté sous `target/`, une ressource du classpath du plugin ; ou pourquoi
 * ce n'est pas établi. Une URL n'est jamais suivie.
 */
function specOf(
  inputSpec: string,
  dir: string,
  files: readonly ReadFile[],
  unpacks: readonly { artifact: string; dir: string }[],
  pluginDeps: readonly string[],
): NonNullable<MavenGeneration['spec']> {
  if (inputSpec.includes('${'))
    return { unresolved: `propriété non résolue dans inputSpec (${shown(inputSpec)})` };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputSpec))
    return { unresolved: `contrat distant non suivi (aucun accès réseau) : ${inputSpec}` };
  const known = new Set(files.map((f) => f.path));
  const cleaned = inputSpec.replace(/^classpath:/, '');
  // Ancré (`${project.basedir}/…`) : relatif à la racine de la source ; sinon relatif au module (Maven).
  const local = anchor(cleaned, dir);
  if (local.startsWith('..'))
    return { unresolved: `contrat hors de la source analysée (${shown(inputSpec)})` };
  if (known.has(local)) return { file: local };
  for (const unpack of unpacks)
    if (local.startsWith(`${unpack.dir}/`))
      return { artifact: unpack.artifact, resource: local.slice(unpack.dir.length + 1) };
  if (
    !cleaned.startsWith(ROOT) &&
    !cleaned.startsWith('/') &&
    !cleaned.includes('..') &&
    pluginDeps.length > 0
  )
    return { artifact: pluginDeps.join(','), resource: cleaned.replace(/^\/+/, '') };
  if (local.includes('/target/') || local.startsWith('target/'))
    return {
      unresolved: `contrat attendu dans la sortie de build (${local}) : aucun dépaquetage lisible ne le fournit`,
    };
  return { unresolved: `fichier de contrat absent de la source (${local})` };
}

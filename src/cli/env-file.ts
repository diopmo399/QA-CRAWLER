import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FICHIER .env : les variables d'environnement de la mission (identifiants, adresse,
 * base de données) dans un fichier gardé hors du dépôt (.gitignore), plutôt que tapées
 * dans le terminal. Une variable déjà définie dans le terminal reste prioritaire. Les
 * valeurs ne sont jamais affichées : seuls les noms peuvent l'être.
 */

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

export interface EnvFileResult {
  /** Le fichier lu, s'il y en a un. */
  file?: string;
  /** Variables ajoutées (noms seulement). */
  loaded: string[];
  /** Variables du fichier ignorées, déjà définies dans le terminal (noms seulement). */
  kept: string[];
}

/**
 * Retire `--dotenv <fichier>` / `--dotenv=<fichier>` des arguments (option commune à
 * toutes les commandes) et renvoie le fichier demandé.
 */
export function takeEnvFileOption(argv: readonly string[]): { argv: string[]; envFile?: string } {
  const rest: string[] = [];
  let envFile: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--dotenv') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-'))
        throw new EnvFileError('--dotenv needs a file: --dotenv .env.qa');
      envFile = value;
      index++;
    } else if (arg.startsWith('--dotenv=')) {
      envFile = arg.slice('--dotenv='.length);
      if (!envFile) throw new EnvFileError('--dotenv needs a file: --dotenv=.env.qa');
    } else rest.push(arg);
  }
  return { argv: rest, ...(envFile !== undefined ? { envFile } : {}) };
}

/**
 * Charge `envFile` (obligatoire s'il est donné), sinon `.env` du dossier courant s'il
 * existe. Sans fichier : rien n'est fait.
 */
export function loadEnvFile(
  envFile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): EnvFileResult {
  const file = path.resolve(cwd, envFile ?? '.env');
  if (!existsSync(file)) {
    if (envFile !== undefined) throw new EnvFileError(`env file not found: ${envFile}`);
    return { loaded: [], kept: [] };
  }
  const values = parseEnvText(readFileSync(file, 'utf8'), path.basename(file));
  const loaded: string[] = [];
  const kept: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (env[name] !== undefined) kept.push(name);
    else {
      env[name] = value;
      loaded.push(name);
    }
  }
  return { file, loaded, kept };
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * NOM=valeur, une par ligne. `#` commence un commentaire (hors guillemets) ; les
 * guillemets simples gardent la valeur telle quelle, les doubles comprennent \n ;
 * `export NOM=…` est accepté. Une ligne invalide est une erreur avec son numéro
 * (jamais sa valeur, qui peut être un secret).
 */
export function parseEnvText(text: string, source = '.env'): Record<string, string> {
  const values: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\uFEFF/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const match = LINE.exec(line);
    if (!match) throw new EnvFileError(`${source}:${String(index + 1)}: expected NAME=value`);
    const name = match[1] ?? '';
    const value = match[2] ?? '';
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const quoted = (quote === '"' ? /^"((?:[^"\\]|\\.)*)"/ : /^'([^']*)'/).exec(value);
      if (!quoted)
        throw new EnvFileError(`${source}:${String(index + 1)}: missing closing quote for ${name}`);
      const inner = quoted[1] ?? '';
      values[name] = quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1') : inner;
      return;
    }
    values[name] = value.replace(/\s+#.*$/, '');
  });
  return values;
}

import { writeFile } from 'node:fs/promises';
import {
  renderQaJobManifest,
  type QaJobManifestOptions,
  type SecretReference,
} from '../platform/kubernetes-manifest.js';
import { UsageError } from './args.js';
import { logger } from './logger.js';

export const MANIFEST_HELP = `qa-crawler k8s-manifest — write a Kubernetes Job (or CronJob) manifest for a mission

Usage:
  qa-crawler k8s-manifest --name <job> --image <image> --config-map <name> --mission <file.yaml> [options]

Options:
      --name <job>              Job name (required)
      --image <image>           Container image (required)
      --config-map <name>       ConfigMap holding the mission file (required)
      --mission <file>          Mission file name inside the ConfigMap (required)
      --namespace <ns>          Namespace
      --command <learn|verify|explore>
      --base-url <url>          QA_BASE_URL
      --secret <ENV=secret/key> Credential by reference (repeatable): QA_PASSWORD=qa-credentials/password
      --env <NAME=value>        Non-secret variable (repeatable)
      --claim <pvc>             PersistentVolumeClaim for reports/ and screenshots/ (default: emptyDir)
      --schedule <cron>         Produce a CronJob
      --parallelism <n>         Indexed Job with n pods (one per actor, for example)
      --service-account <name>
      --out <file>              Write the manifest to this file (default: stdout)
  -h, --help

Secrets are referenced (secretKeyRef), never written in the manifest.
`;

interface ManifestArgs {
  help: boolean;
  out?: string;
  options: QaJobManifestOptions;
}

export function parseManifestArgs(argv: readonly string[]): ManifestArgs {
  const values: Record<string, string> = {};
  const secrets: SecretReference[] = [];
  const env: Record<string, string> = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '-h' || flag === '--help') {
      help = true;
      continue;
    }
    if (!flag.startsWith('--')) throw new UsageError(`unexpected argument "${flag}"`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    index += 1;
    if (flag === '--secret') {
      const match = /^([A-Z0-9_]+)=([^/]+)\/(.+)$/.exec(value);
      if (!match?.[1] || !match[2] || !match[3])
        throw new UsageError(`--secret expects ENV=secretName/key, got "${value}"`);
      secrets.push({ env: match[1], secretName: match[2], key: match[3] });
    } else if (flag === '--env') {
      const separator = value.indexOf('=');
      if (separator <= 0) throw new UsageError(`--env expects NAME=value, got "${value}"`);
      env[value.slice(0, separator)] = value.slice(separator + 1);
    } else values[flag.slice(2)] = value;
  }
  if (help)
    return { help, options: { name: '', image: '', mission: { configMap: '', file: '' }, secrets: [] } };
  for (const required of ['name', 'image', 'config-map', 'mission'])
    if (!values[required]) throw new UsageError(`--${required} is required`);
  const command = values.command;
  if (command !== undefined && command !== 'learn' && command !== 'verify' && command !== 'explore')
    throw new UsageError(`--command must be learn, verify or explore`);
  const parallelism = values.parallelism !== undefined ? Number(values.parallelism) : undefined;
  if (parallelism !== undefined && (!Number.isInteger(parallelism) || parallelism < 1))
    throw new UsageError('--parallelism must be a positive integer');
  return {
    help,
    ...(values.out ? { out: values.out } : {}),
    options: {
      name: values.name ?? '',
      image: values.image ?? '',
      mission: { configMap: values['config-map'] ?? '', file: values.mission ?? '' },
      secrets,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(values.namespace ? { namespace: values.namespace } : {}),
      ...(command ? { command } : {}),
      ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      ...(values.claim ? { reports: { claimName: values.claim } } : {}),
      ...(values.schedule ? { schedule: values.schedule } : {}),
      ...(parallelism !== undefined ? { parallelism } : {}),
      ...(values['service-account'] ? { serviceAccount: values['service-account'] } : {}),
    },
  };
}

export async function runManifestCli(argv: readonly string[]): Promise<number> {
  let args: ManifestArgs;
  try {
    args = parseManifestArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(MANIFEST_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(MANIFEST_HELP);
    return 0;
  }
  let manifest: string;
  try {
    manifest = renderQaJobManifest(args.options);
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (args.out) {
    await writeFile(args.out, manifest, 'utf8');
    logger.info(`Manifest written to ${args.out}`);
  } else logger.info(manifest);
  return 0;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Branche et commit de l'application testée, quand ils sont connus. */
export interface SourceInfo {
  branch?: string;
  commit?: string;
}

/**
 * D'où vient le build testé. Le crawler ne tourne généralement pas dans le
 * dépôt de l'application, donc les valeurs explicites l'emportent : la mission
 * (`baseline.branch` / `baseline.commit`), puis QA_BRANCH / QA_COMMIT, puis
 * les variables de CI habituelles (GitHub Actions, GitLab CI), puis `git` dans
 * `baseline.gitDir` s'il est donné. Tout est facultatif.
 */
export async function sourceInfo(
  explicit: SourceInfo & { gitDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourceInfo> {
  let branch =
    explicit.branch ?? env.QA_BRANCH ?? env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? env.CI_COMMIT_REF_NAME;
  let commit = explicit.commit ?? env.QA_COMMIT ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
  if (explicit.gitDir && (!branch || !commit)) {
    const git = async (...args: string[]): Promise<string | undefined> => {
      try {
        const { stdout } = await run('git', ['-C', explicit.gitDir ?? '.', ...args], { timeout: 3000 });
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    };
    branch ??= await git('rev-parse', '--abbrev-ref', 'HEAD');
    commit ??= await git('rev-parse', 'HEAD');
  }
  return { ...(branch ? { branch } : {}), ...(commit ? { commit } : {}) };
}

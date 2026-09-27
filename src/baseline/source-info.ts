import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Branch and commit of the application under test, when known. */
export interface SourceInfo {
  branch?: string;
  commit?: string;
}

/**
 * Where the tested build comes from. The crawler usually does not run inside
 * the application's repository, so the explicit values win: the mission
 * (`baseline.branch` / `baseline.commit`), then QA_BRANCH / QA_COMMIT, then
 * the usual CI variables (GitHub Actions, GitLab CI), then `git` in
 * `baseline.gitDir` when given. Everything is optional.
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

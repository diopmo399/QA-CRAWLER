# CI examples for a consumer project

Pipelines that run `npx qa-crawler analyze` in a project where `@qa-crawler/cli` is installed, and
keep the tool's memory (`qa-crawler/knowledge`, `qa-crawler/memory`, `qa-crawler/baselines`)
between runs **without a database**: a tarball is restored from a generic Artifactory repository
before the run and uploaded after it (`latest.tgz` plus a copy per run under `history/`).

| File                          | Platform       |
| ----------------------------- | -------------- |
| `github-actions-consumer.yml` | GitHub Actions |
| `gitlab-ci-consumer.yml`      | GitLab CI      |

Both keep one run at a time per application (the file provider merges JSON files on one disk),
publish `qa-reports/` as a job artifact and map the exit codes: 0 passed, 1 QA failure (job fails),
2 configuration, 3 infrastructure. The memory is saved after a 0 or a 1 only.

Alternatives: commit the three folders to a branch of the project (remove them from `.gitignore`),
or use the platform cache (`actions/cache`, GitLab `cache:`) when a purge is acceptable.

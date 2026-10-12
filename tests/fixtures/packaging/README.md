# Packaging fixtures

Four consumer projects used by `npm run test:packaging` (vitest project `packaging`): the two
packages are built, packed with `npm pack`, installed from the tarballs into a copy of each fixture
(`npm install -D <core.tgz> <cli.tgz> --omit=optional`), then `npx qa-crawler --version`, `init`
and a run (`replay`, `analyze`, `test-api`) are executed against the fixture served over HTTP.

| Fixture           | Detected as                            | Checks                                                                |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `angular-app`     | Angular, TypeScript, playwright.config | `init` reuses baseURL/viewport, YAML + Gherkin flows, `replay` passes |
| `react-app`       | React (Vite)                           | form flow (`allow: MUTATION`), `analyze` passes, `generate-tests`     |
| `generic-web-app` | no framework, no package.json          | a deliberately failing flow: `analyze` exits with 1                   |
| `openapi-app`     | Vue + OpenAPI contract                 | `test-api` runs the contract against the served API                   |

Each `public/` folder is a static stand-in for the framework build; no real framework is installed.

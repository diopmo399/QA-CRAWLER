/**
 * LA PAGE AUTONOME du serveur SDK : l'assistant en pleine page (mode `standalone`), avec le jeton
 * de la session passé à l'élément. Les modules viennent du même serveur (/sdk/ui/index.js).
 */
export function sdkStandalonePage(options: { token: string; nonce: string; language: 'fr' | 'en' }): string {
  const title = options.language === 'fr' ? 'QA-CRAWLER — Nouveau projet' : 'QA-CRAWLER — New project';
  return `<!doctype html>
<html lang="${options.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%}body{background:#F5F6FB}qa-crawler-project-wizard{display:block;min-height:100vh}</style>
</head>
<body>
<qa-crawler-project-wizard mode="standalone" endpoint="/api" locale="${options.language}"></qa-crawler-project-wizard>
<script type="module" nonce="${options.nonce}">
import '/sdk/ui/index.js';
const wizard = document.querySelector('qa-crawler-project-wizard');
wizard.token = ${JSON.stringify(options.token)};
</script>
</body>
</html>
`;
}

/**
 * LE FLOW STUDIO en pleine page : `/studio?project=<id>&recording=<nom>`. Le projet et
 * l'enregistrement sont lus dans l'adresse par le script de la page (jamais recopiés dans le HTML).
 */
export function flowStudioHtml(options: { token: string; nonce: string; language: 'fr' | 'en' }): string {
  return `<!doctype html>
<html lang="${options.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER — Flow Studio</title>
<style>html,body{margin:0;height:100%}body{background:#F5F6FB;padding:16px;box-sizing:border-box}qa-crawler-flow-studio{height:calc(100vh - 32px)}</style>
</head>
<body>
<qa-crawler-flow-studio endpoint="/api" locale="${options.language}"></qa-crawler-flow-studio>
<script type="module" nonce="${options.nonce}">
import '/sdk/ui/index.js';
const studio = document.querySelector('qa-crawler-flow-studio');
const query = new URLSearchParams(location.search);
for (const name of ['project', 'recording', 'theme']) {
  const value = query.get(name);
  if (value) studio.setAttribute(name, value);
}
studio.token = ${JSON.stringify(options.token)};
</script>
</body>
</html>
`;
}

/** La page autonome de <qa-crawler-run-compare> : `/runs?project=…&base=run-…&head=run-…`. */
export function runComparePage(options: { token: string; nonce: string; language: 'fr' | 'en' }): string {
  return `<!doctype html>
<html lang="${options.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER — Runs</title>
<style>html,body{margin:0}body{background:#F5F6FB;padding:16px;box-sizing:border-box}</style>
</head>
<body>
<qa-crawler-run-compare endpoint="/api" locale="${options.language}"></qa-crawler-run-compare>
<script type="module" nonce="${options.nonce}">
import '/sdk/ui/index.js';
const runs = document.querySelector('qa-crawler-run-compare');
const query = new URLSearchParams(location.search);
for (const name of ['project', 'base', 'head', 'theme']) {
  const value = query.get(name);
  if (value) runs.setAttribute(name, value);
}
runs.token = ${JSON.stringify(options.token)};
</script>
</body>
</html>
`;
}

/** La page autonome de <qa-crawler-run-monitor> : `/monitor?exploration=…`. */
export function runMonitorPage(options: { token: string; nonce: string; language: 'fr' | 'en' }): string {
  return `<!doctype html>
<html lang="${options.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER — Run Monitor</title>
<style>html,body{margin:0}body{background:#F5F6FB;padding:16px;box-sizing:border-box}</style>
</head>
<body>
<qa-crawler-run-monitor endpoint="/api" locale="${options.language}"></qa-crawler-run-monitor>
<script type="module" nonce="${options.nonce}">
import '/sdk/ui/index.js';
const monitor = document.querySelector('qa-crawler-run-monitor');
const query = new URLSearchParams(location.search);
for (const name of ['exploration', 'theme']) {
  const value = query.get(name);
  if (value) monitor.setAttribute(name, value);
}
monitor.token = ${JSON.stringify(options.token)};
</script>
</body>
</html>
`;
}

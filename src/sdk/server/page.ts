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

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/accounts');

/**
 * Le rendu du composant AccountFormComponent tel qu'Angular le produirait : classes
 * ng-valid / ng-invalid, champs affichés selon le type de compte, provinces chargées
 * depuis l'API. Volontairement, la province n'est PAS rendue obligatoire pour le Canada
 * (le code dit le contraire) : le crawler doit le voir comme RUNTIME_CONTRADICTED.
 */
const PAGE = `<!doctype html><html><head><title>Comptes</title></head><body>
<h1>Nouveau compte</h1>
<form id="account" novalidate>
  <label>Courriel <input type="email" formcontrolname="email"></label>
  <label>Type de compte <select formcontrolname="accountType">
    <option value="PERSONAL">Personnel</option><option value="BUSINESS">Entreprise</option>
  </select></label>
  <div id="business"></div>
  <label>Pays <select formcontrolname="country"><option value="CA">Canada</option><option value="FR">France</option></select></label>
  <div id="provinceBox"><label>Province <select formcontrolname="province"><option value="">Choisir…</option></select></label></div>
  <label>Numéro client <input type="text" formcontrolname="customerId"></label>
  <label>Âge <input type="number" formcontrolname="age"></label>
  <label>Tuteur <input type="text" formcontrolname="guardianName"></label>
  <label>Quantité <input type="number" formcontrolname="quantity" value="1"></label>
  <label>Prix <input type="number" formcontrolname="price" value="20"></label>
  <label>Total <input type="number" formcontrolname="total" value="20" readonly></label>
  <button type="submit" id="save">Enregistrer</button>
</form>
<script>
  const $ = (name) => document.querySelector('[formcontrolname="' + name + '"]');
  const form = document.getElementById('account');
  form.addEventListener('submit', (event) => event.preventDefault());
  function mark(el, valid) {
    if (!el) return;
    el.classList.toggle('ng-valid', valid);
    el.classList.toggle('ng-invalid', !valid);
    if (!el.classList.contains('ng-dirty')) el.classList.add('ng-pristine');
  }
  function renderBusiness() {
    const box = document.getElementById('business');
    const business = $('accountType').value === 'BUSINESS';
    if (business && !$('companyName')) {
      box.innerHTML = '<label>Raison sociale <input type="text" formcontrolname="companyName"></label>' +
        '<label>Numéro d’entreprise <input type="text" formcontrolname="companyNumber"></label>';
      box.querySelectorAll('input').forEach((input) => input.addEventListener('input', refresh));
    }
    if (!business) box.innerHTML = '';
  }
  async function loadProvinces() {
    const country = $('country').value;
    document.getElementById('provinceBox').style.display = country === 'CA' ? '' : 'none';
    const response = await fetch('/api/provinces?country=' + country);
    const provinces = await response.json();
    const select = $('province');
    select.innerHTML = '<option value="">Choisir…</option>' + provinces.map((p) => '<option value="' + p + '">' + p + '</option>').join('');
    refresh();
  }
  function refresh() {
    renderBusiness();
    const email = $('email');
    mark(email, /.+@.+/.test(email.value));
    mark($('accountType'), true);
    mark($('companyName'), true);
    const number = $('companyNumber');
    if (number) mark(number, number.value.trim() !== '');
    mark($('country'), true);
    mark($('province'), true); // contradiction voulue : jamais obligatoire
    mark($('customerId'), true);
    mark($('age'), true);
    const age = Number($('age').value);
    const minor = $('age').value !== '' && age > 0 && age < 18;
    mark($('guardianName'), !minor || $('guardianName').value.trim() !== '');
    mark($('quantity'), true);
    mark($('price'), true);
    mark($('total'), true);
    $('total').value = String(Number($('quantity').value) * Number($('price').value));
    const invalid = document.querySelectorAll('#account .ng-invalid').length > 0;
    document.getElementById('save').disabled = invalid;
  }
  document.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', refresh));
  $('accountType').addEventListener('change', refresh);
  $('country').addEventListener('change', loadProvinces);
  fetch('/api/profile').then((r) => r.json()).then((profile) => {
    $('email').value = profile.email;
    $('accountType').value = profile.accountType;
    refresh();
  });
  $('country').value = 'CA';
  loadProvinces();
  refresh();
</script>
</body></html>`;

describe('application rules end to end (Chromium): code → rules → runtime verification', () => {
  let server: Server;
  let url: string;
  let dir: string;
  const requests: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-rules-e2e-'));
    server = createServer((request, response) => {
      const route = request.url ?? '/';
      requests.push(`${request.method ?? 'GET'} ${route}`);
      if (route === '/api/profile') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ email: 'profil.fixture@example.test', accountType: 'BUSINESS' }));
      } else if (route.startsWith('/api/provinces')) {
        const country = new URL(route, 'http://x').searchParams.get('country');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(country === 'CA' ? ['QC', 'ON'] : ['IDF']));
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const run = async (
    rulesEnabled: boolean,
    flows = '',
  ): Promise<{ result: ExplorationResult; log: string; html: string }> => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { config } = parseConfig(
      `
mission: { name: rules-e2e }
target: { baseUrl: ${url}, startAt: /accounts/new }
exploration: { ${flows ? 'autonomous: false, ' : ''}maxStates: 4, maxActions: 6, actionTimeoutMs: 3000, settleTimeMs: 80 }
forms: { exercise: false }
staticAnalysis:
  enabled: true
  source: { root: ${FIXTURE} }
  cache: { enabled: false }
rules: { enabled: ${String(rulesEnabled)} }
${flows}
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
      {},
      {},
    );
    const { result } = await runMission(config);
    const entries = await readdir(reports, { recursive: true });
    const logFile = entries.find((entry) => entry.endsWith('engine-log.jsonl'));
    const log = logFile ? await readFile(path.join(reports, logFile), 'utf8') : '';
    const html = await readFile(path.join(reports, 'reports', 'index.html'), 'utf8');
    return { result, log, html };
  };

  it('prefilled fields are kept and explained; rules are confirmed, contradicted, blocked — never forced', async () => {
    const { result, log, html } = await run(true);
    const rules = result.formRules?.rules;
    expect(rules).toBeDefined();
    const byName = new Map((rules?.items ?? []).map((rule) => [rule.name, rule]));
    const printable = (rules?.items ?? [])
      .map((rule) => `${rule.name}: ${rule.status} ${rule.coverage}`)
      .join('\n');

    // État des champs : préremplis par le profil (API), valeur par défaut, calculé.
    const fields = result.formRules?.fieldStates[0]?.fields ?? [];
    const field = (id: string) => fields.find((entry) => entry.fieldId === id);
    expect(field('email')).toMatchObject({
      state: 'PREFILLED',
      origin: 'PROFILE_PREFILLED',
      decision: 'KEEP',
    });
    expect(field('email')?.source).toContain('GET /api/profile');
    expect(field('accountType')).toMatchObject({ state: 'PREFILLED', decision: 'KEEP' });
    expect(field('country')).toMatchObject({
      state: 'DEFAULT_VALUE',
      origin: 'FORM_DEFAULT',
      decision: 'KEEP',
    });
    expect(field('total')).toMatchObject({ state: 'DERIVED_VALUE', decision: 'OBSERVE_ONLY' });

    // Règle confirmée SANS modifier le type de compte prérempli.
    expect(byName.get('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER'), printable).toMatchObject({
      category: 'VALIDATION',
      status: 'RUNTIME_CONFIRMED',
      coverage: 'VERIFIED',
    });
    expect(byName.get('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER')?.network.join()).toContain(
      'POST /api/accounts',
    );
    expect(log).not.toMatch(/RULE_VERIFICATION_STARTED[^\n]*accountType/);

    // Le code dit « province obligatoire au Canada », l'application non : contredite, avec contexte, pas un bug.
    const province = byName.get('COUNTRY_CA_REQUIRES_PROVINCE');
    expect(province, printable).toMatchObject({ status: 'RUNTIME_CONTRADICTED', coverage: 'CONTRADICTED' });
    expect(province?.contradiction?.route).toBeDefined();
    expect(result.issues.some((issue) => /CONFIRMED_BUG/.test(issue.message))).toBe(false);

    // Options chargées par l'API quand le pays change (valeur posée puis rétablie).
    expect(byName.get('COUNTRY_CHANGE_LOADS_OPTIONS_OF_PROVINCE'), printable).toMatchObject({
      status: 'RUNTIME_CONFIRMED',
    });
    // Âge < 18 → tuteur obligatoire : vérifié en posant un âge, puis rétabli.
    expect(byName.get('AGE_ABOVE_0_AND_AGE_BELOW_18_REQUIRES_GUARDIAN_NAME'), printable).toMatchObject({
      status: 'RUNTIME_CONFIRMED',
    });
    // Bouton désactivé tant que le formulaire est invalide.
    expect(byName.get('FORM_INVALID_OR_LOADING_DISABLES_ENREGISTRER'), printable).toMatchObject({
      status: 'RUNTIME_CONFIRMED',
    });
    // Calcul : le total suit la quantité.
    expect(byName.get('QUANTITY_CHANGE_CALCULATES_TOTAL'), printable).toMatchObject({
      status: 'RUNTIME_CONFIRMED',
    });
    // Permission : jamais un rôle changé pour vérifier.
    expect(byName.get('IS_ADMIN_SHOWS_ADMINISTRATION')?.coverage).toBe('BLOCKED_BY_CONTEXT');
    // Règle métier sans moyen sûr de la produire : non vérifiée, pas devinée.
    expect(byName.get('TOTAL_ABOVE_1000_AND_CUSTOMER_TYPE_BUSINESS_SETS_DISCOUNT')?.coverage).toBe(
      'NOT_VERIFIED',
    );

    // Dépendances : pays → province (options, réseau), quantité → total.
    const dependencies = (result.formRules?.dependencies ?? []).map(
      (edge) => `${edge.from}->${edge.to}:${edge.kind}`,
    );
    expect(dependencies).toEqual(
      expect.arrayContaining([
        'country->province:OPTIONS_DEPENDENCY',
        'country->GET /api/provinces:NETWORK_DEPENDENCY',
        'accountType->companyNumber:VISIBILITY_DEPENDENCY',
        'quantity->total:DERIVATION_DEPENDENCY',
      ]),
    );

    // Condition technique écartée.
    expect(rules?.technicalConditions).toBeGreaterThanOrEqual(1);
    expect(rules?.coverage.discovered).toBeGreaterThanOrEqual(10);
    expect(rules?.coverage.confirmed).toBeGreaterThanOrEqual(5);

    // Rapport et journal ; jamais la valeur préremplie (le courriel du profil) en clair.
    expect(html).toContain('Application rules');
    expect(html).toContain('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER');
    expect(log).toContain('RULE_RUNTIME_CONFIRMED');
    expect(log).toContain('RULE_RUNTIME_CONTRADICTED');
    const everything = [html, log, JSON.stringify(result)].join('\n');
    expect(everything).not.toContain('profil.fixture@example.test');
    // Aucun envoi : la règle qui en aurait besoin reste bloquée par la politique.
    expect(requests.some((entry) => entry.startsWith('POST'))).toBe(false);
  }, 120_000);

  it('explicit scenario value on a field that already has one: REPLACE (EXPLICIT_SCENARIO_VALUE), explained', async () => {
    const feature = path.join(dir, 'pays.feature');
    await writeFile(
      feature,
      '# language: fr\nFonctionnalité: Compte\n  Scénario: Pays\n    Étant donné que je suis sur "/accounts/new"\n    Quand je sélectionne "France" comme pays\n',
    );
    const { result } = await run(
      false,
      `gherkin: { semanticResolution: { enabled: true } }\nflows:\n  - gherkin: ${feature}`,
    );
    const step = result.flows[0]?.steps.find((entry) => entry.kind === 'intent');
    expect(step?.status).toBe('PASSED');
    expect(step?.interpretation).toContain('REPLACE (EXPLICIT_SCENARIO_VALUE)');
  }, 120_000);

  it('rules disabled (non-regression): no rule, no value changed by the crawler, field states still explained', async () => {
    const before = requests.length;
    const { result } = await run(false);
    expect(result.formRules?.rules).toBeUndefined();
    expect(
      requests.slice(before).filter((entry) => entry.startsWith('GET /api/provinces?country=FR')),
    ).toHaveLength(0);
  }, 120_000);
});

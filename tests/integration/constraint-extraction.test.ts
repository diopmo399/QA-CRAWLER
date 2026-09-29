import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  DomOpenApiConstraintExtractor,
  formConflicts,
  type FormConstraints,
} from '../../src/constraints/constraints.js';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import { DomFormAnalyzer } from '../../src/forms/form-analyzer.js';
import type { DiscoveredForm } from '../../src/forms/form-model.js';
import type { PageContext } from '../../src/model/page-context.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

/** Les contraintes d'un vrai formulaire, lues par l'UIObserver (une seule lecture du DOM) puis fusionnées avec OpenAPI. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Members</title></head><body>
<h1>New member</h1>
<form id="member" onsubmit="event.preventDefault()">
  <label for="name">Name</label><input id="name" name="name" required minlength="2" maxlength="50">
  <label for="email">Email</label><input id="email" name="email" type="email" aria-required="true" maxlength="100">
  <label for="age">Age</label><input id="age" name="age" type="number" min="18" max="120" step="1" required aria-required="true">
  <label for="code">Code</label><input id="code" name="code" pattern="[A-Z]{3}[0-9]{3}">
  <label for="tags">Tags</label><select id="tags" name="tags" multiple><option>News</option><option>Events</option></select>
  <label for="ref">Reference</label><input id="ref" name="ref" readonly>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" aria-invalid="true">
  <button type="submit">Save</button>
</form>
</body></html>`;

const contract = parseOpenApi(`
openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /api/members:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [name, email]
              properties:
                name: { type: string, minLength: 2, maxLength: 50 }
                email: { type: string, format: email, maxLength: 80 }
                age: { type: integer, minimum: 18, maximum: 120 }
                code: { type: string, pattern: '^[A-Z]{3}[0-9]{3}$' }
      responses: { '201': { description: ok } }
`);

describe('constraint extraction on a real form (HTML + ARIA + OpenAPI)', () => {
  let browser: Browser;
  let form: DiscoveredForm;
  let constraints: FormConstraints;
  const byName = (name: string) => {
    const field = form.fields.find((entry) => entry.name === name);
    return field ? constraints[field.id] : undefined;
  };

  beforeAll(async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const snapshot = await new UIObserver().observe(page);
    const actions = new ActionDiscovery(new SafetyPolicy(testConfig().safety)).discover(snapshot, 'member');
    const context = {
      stateId: 'member',
      title: 'Members',
      headings: ['New member'],
      dialogs: [],
      actions,
    } as unknown as PageContext;
    [form] = new DomFormAnalyzer().formsOf(context) as [DiscoveredForm];
    constraints = new DomOpenApiConstraintExtractor().extractForm(form, contract);
  });
  afterAll(async () => {
    await browser.close();
  });

  it('keeps where "required" comes from: the HTML attribute, aria-required, or both', () => {
    expect(byName('name')?.sources?.required).toEqual(['HTML', 'OPENAPI']);
    expect(byName('email')?.sources?.required).toEqual(['ARIA', 'OPENAPI']);
    expect(byName('age')?.sources?.required).toEqual(['HTML', 'ARIA']);
    expect(byName('age')?.confidence?.required).toBe(0.95);
  });

  it('agreeing sources raise the confidence; a pattern is compared without its anchors', () => {
    expect(byName('name')).toMatchObject({ minLength: 2, maxLength: 50 });
    expect(byName('name')?.sources?.maxLength).toEqual(['HTML', 'OPENAPI']);
    expect(byName('age')).toMatchObject({ min: 18, max: 120, step: 1, format: 'integer' });
    expect(byName('age')?.sources?.min).toEqual(['HTML', 'OPENAPI']);
    expect(byName('code')?.sources?.pattern).toEqual(['HTML', 'OPENAPI']);
  });

  it('maxlength=100 on the page, maxLength=80 in the API: a CONSTRAINT_MISMATCH with both values', () => {
    expect(formConflicts(constraints)).toEqual([
      expect.objectContaining({
        constraint: 'maxLength',
        values: [
          { source: 'HTML', value: 100 },
          { source: 'OPENAPI', value: 80 },
        ],
        effective: 'HTML',
      }),
    ]);
    expect(formConflicts(constraints)[0]?.fieldId).toBe(form.fields.find((f) => f.name === 'email')?.id);
  });

  it('reads multiple and aria-invalid from the same observation; a readonly field is not a field to fill', () => {
    expect(byName('tags')).toMatchObject({ multiple: true, type: 'array', control: 'select' });
    // Un champ en lecture seule n'est pas une action : l'utilisateur ne peut rien y saisir, rien à tester.
    expect(byName('ref')).toBeUndefined();
    expect(byName('phone')?.observedInvalid).toBe(true);
  });
});

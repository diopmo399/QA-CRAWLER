import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import { PlaywrightActionExecutor } from '../../src/execution/playwright-action-executor.js';
import { DomFormAnalyzer } from '../../src/forms/form-analyzer.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

/**
 * A form built with web components: fields drawn inside open shadow roots,
 * labels given through the component (label attribute, <slot name="label">),
 * a <select> inside a component, a contenteditable field, and a button drawn
 * by a component — all inside a plain <form>.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Components</title>
<script>
  // label="…" on the component; the <input> inside has no label of its own.
  customElements.define('qa-input', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div class="box"><input id="inner" type="' + (this.getAttribute('type') || 'text') + '"></div>';
    }
  });
  // The label is slotted: <span slot="label">Email</span>, associated inside the shadow root.
  customElements.define('qa-field', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<label for="f"><slot name="label">Field</slot></label><input id="f" type="email" required>';
    }
  });
  customElements.define('qa-select', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<label for="s">' + this.getAttribute('label') + '</label>'
        + '<select id="s"><option value="">-- Choose --</option><option>Reader</option><option>Editor</option></select>';
    }
  });
  customElements.define('qa-button', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<button type="button"><slot></slot></button>';
    }
  });
</script></head><body>
<h1>New member</h1>
<form id="member" onsubmit="event.preventDefault()">
  <qa-input label="First name"></qa-input>
  <qa-field><span slot="label">Email</span></qa-field>
  <qa-select label="Role"></qa-select>
  <div contenteditable="true" aria-label="Comment" style="min-height:40px;border:1px solid #999"></div>
  <qa-button>Preview</qa-button>
</form>
</body></html>`;

describe('forms built with web components (shadow DOM, slots, contenteditable)', () => {
  let browser: Browser;
  let page: Page;
  let actions: DiscoveredAction[];
  const config = testConfig('forms: { autoFill: true }');
  const observer = new UIObserver();

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(PAGE);
    const snapshot = await observer.observe(page);
    actions = new ActionDiscovery(new SafetyPolicy(config.safety)).discover(snapshot, 'member');
  });
  afterAll(async () => {
    await browser.close();
  });

  const field = (label: string): DiscoveredAction | undefined =>
    actions.find((action) => action.field?.label === label || action.label === label);

  it('discovers the fields drawn inside the components, with the labels the page gave them', () => {
    expect(field('First name')).toMatchObject({ type: 'fill' });
    expect(field('Email')).toMatchObject({ type: 'fill', field: { inputType: 'email', required: true } });
    expect(field('Role')).toMatchObject({ type: 'select' });
    expect(field('Role')?.field?.options).toEqual(['-- Choose --', 'Reader', 'Editor']);
    expect(field('Comment')).toMatchObject({ type: 'fill' });
    expect(actions.some((action) => action.type === 'click' && action.text === 'Preview')).toBe(true);
  });

  it('groups them in the form around the components', () => {
    const context = {
      stateId: 'member',
      title: 'Components',
      headings: ['New member'],
      dialogs: [],
      actions,
    } as unknown as PageContext;
    const [form] = new DomFormAnalyzer().formsOf(context);
    expect(form?.group).toBe('form:0');
    expect(form?.fields.map((entry) => entry.label)).toEqual(['First name', 'Email', 'Role', 'Comment']);
    expect(form?.fields.find((entry) => entry.label === 'Comment')?.type).toBe('textarea');
  });

  it('fills every field through its locator (the shadow roots are pierced)', async () => {
    const executor = new PlaywrightActionExecutor(3000, 0);
    const fill = async (label: string, value: string): Promise<void> => {
      const action = field(label);
      if (!action) throw new Error(`no field ${label}`);
      const result = await executor.execute(page, action, { value });
      expect(result.status, `${label}: ${result.error ?? ''}`).toBe('SUCCESS');
    };
    await fill('First name', 'Awa');
    await fill('Email', 'qa@example.test');
    await fill('Role', 'Editor');
    await fill('Comment', 'Hello');
    const values = await page.evaluate(() => {
      const inner = (tag: string, selector: string): string =>
        (document.querySelector(tag)?.shadowRoot?.querySelector(selector) as HTMLInputElement | null)
          ?.value ?? '';
      return {
        firstName: inner('qa-input', 'input'),
        email: inner('qa-field', 'input'),
        role: inner('qa-select', 'select'),
        comment: document.querySelector('[contenteditable]')?.textContent ?? '',
      };
    });
    expect(values).toEqual({ firstName: 'Awa', email: 'qa@example.test', role: 'Editor', comment: 'Hello' });
  });
});

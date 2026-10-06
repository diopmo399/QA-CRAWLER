import { describe, expect, it } from 'vitest';
import { extractFacts } from '../../src/static-analysis/ts-facts.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';

/**
 * Un bundle de production (sans source map) : `Validators` est renommé (`Ue.required`), les noms de
 * propriétés restent. Les validateurs d'un formulaire réactif sont reconnus quand même ; un appel
 * quelconque (Math.min, un service) hors d'une liste de validateurs ne l'est jamais.
 */
describe('Validators in a minified production bundle', () => {
  it('fb.group({ legalName: ["", [Ue.required, Ue.maxLength(80)]] }) → required + maxLength(80)', async () => {
    const ts = await loadTypeScript();
    if (!ts) return;
    const bundle =
      'class n{constructor(t){this.fb=t,this.form=this.fb.group({legalName:["",[Ue.required,Ue.maxLength(80)]],code:["",Ue.pattern("^[0-9]{5}$")],note:[""]})}save(){return Math.min(1,2)}}';
    const facts = extractFacts(ts, 'bundle/main.js', bundle, { remaining: 100_000 });
    const controls = JSON.stringify(facts.classes);
    expect(controls).toContain('"legalName"');
    expect(controls).toMatch(/"kind":"required"/);
    expect(controls).toMatch(/"kind":"maxLength","value":80/);
    expect(controls).toMatch(/"kind":"pattern","value":"\^\[0-9\]\{5\}\$"/);
  });

  it('a long identifier that is not Validators is not taken for it (a service with a required() method)', async () => {
    const ts = await loadTypeScript();
    if (!ts) return;
    const bundle =
      'class n{constructor(t){this.fb=t,this.form=this.fb.group({city:["",[permissionService.required]]})}}';
    const facts = extractFacts(ts, 'bundle/main.js', bundle, { remaining: 100_000 });
    expect(JSON.stringify(facts.classes)).not.toMatch(/"kind":"required"/);
  });
});

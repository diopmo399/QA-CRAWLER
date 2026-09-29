import { describe, expect, it } from 'vitest';
import { card, issuesCard, layoutSections } from '../../src/reporting/html-common.js';

describe('report layout', () => {
  const layout = layoutSections(
    [
      {
        title: 'Results',
        collapsed: false,
        sections: [
          { html: '<section><h2>HTTP errors (1)</h2><table></table></section>', alert: true },
          '<section><h2>JavaScript errors</h2><p class="empty">None.</p></section>',
          '',
        ],
      },
      { title: 'Empty', collapsed: false, sections: ['', '  '] },
      {
        title: 'Detailed analysis',
        hint: 'Click a title to expand it.',
        collapsed: true,
        sections: ['<section><h2>Decision <span class="pill">engine</span></h2><p>detail</p></section>'],
      },
    ],
    'Contents',
  );

  it('anchors every section and lists it in the table of contents', () => {
    // « (1) » devient un badge, rouge quand la section signale des anomalies.
    expect(layout.body).toContain(
      '<section id="section-1"><h2>HTTP errors <span class="count alert">1</span></h2>',
    );
    expect(layout.body).toContain('<section id="section-2"><h2>JavaScript errors</h2>');
    expect(layout.toc).toContain(
      '<li class="alert"><a href="#section-1"><span>HTTP errors</span> <span class="count alert">1</span></a></li>',
    );
    expect(layout.toc).toContain('<li><a href="#section-2"><span>JavaScript errors</span></a></li>');
    // Le sommaire garde le texte du titre, sans le balisage.
    expect(layout.toc).toContain('<a href="#section-3"><span>Decision engine</span></a>');
  });

  it('collapses the detailed analysis and drops empty groups', () => {
    expect(layout.body).toContain(
      '<section id="section-3"><details><summary><h2>Decision <span class="pill">engine</span></h2></summary><p>detail</p></details></section>',
    );
    expect(layout.body).toContain('Click a title to expand it.');
    expect(layout.body).not.toContain('Empty');
    expect(layout.toc).not.toContain('Empty');
    expect(layout.body.indexOf('section-1')).toBeLessThan(layout.body.indexOf('section-3'));
  });

  it('keeps a fragment without a section heading as is', () => {
    const plain = layoutSections([{ title: 'X', collapsed: true, sections: ['<p>note</p>'] }], 'Contents');
    expect(plain.body).toContain('<p>note</p>');
    expect(plain.toc).not.toContain('section-');
  });
});

describe('summary cards', () => {
  it('keeps zero values neutral and shows the severity split of the anomalies', () => {
    expect(card('Error', 0, '#dc2626')).toContain('class="card accent zero"');
    expect(card('Error', 0, '#dc2626')).not.toContain('--accent');
    expect(card('Error', 2, '#dc2626')).toContain('style="--accent:#dc2626"');
    const issues = issuesCard('Issues', { CRITICAL: 0, ERROR: 2, WARNING: 1, INFO: 0 }, (value) => value);
    expect(issues).toContain('<div class="value">3</div>');
    expect(issues).toContain('flex:2;background:#dc2626');
    expect(issues).toContain('flex:1;background:#b45309');
    expect(issuesCard('Issues', { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 }, (v) => v)).toContain(
      'class="card issues zero"',
    );
  });
});

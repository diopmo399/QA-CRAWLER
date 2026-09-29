import { describe, expect, it } from 'vitest';
import { layoutSections } from '../../src/reporting/html-common.js';

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
    expect(layout.body).toContain('<section id="section-1"><h2>HTTP errors (1)</h2>');
    expect(layout.body).toContain('<section id="section-2"><h2>JavaScript errors</h2>');
    expect(layout.toc).toContain('<li class="alert"><a href="#section-1">HTTP errors (1)</a></li>');
    expect(layout.toc).toContain('<li><a href="#section-2">JavaScript errors</a></li>');
    // Le sommaire garde le texte du titre, sans le balisage.
    expect(layout.toc).toContain('<a href="#section-3">Decision engine</a>');
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

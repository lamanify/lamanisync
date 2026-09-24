// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../website/src/data/markdown.js';

describe('renderMarkdown compiler', () => {
  it('preserves language and escapes HTML in code blocks', () => {
    const codeMd = '```json\n{"test": true, "raw": "<tag>"}\n```';
    const codeHtml = renderMarkdown(codeMd);
    expect(codeHtml).toContain('<pre class="article-code" data-language="json"><code>');
    expect(codeHtml).toContain('&lt;tag&gt;');
  });

  it('renders markdown tables with inline formatting', () => {
    const tableMd = `
| Header 1 | Header 2 |
| :--- | :--- |
| Cell 1 | **Cell 2** |
`;
    const tableHtml = renderMarkdown(tableMd);
    expect(tableHtml).toContain('<table class="article-table">');
    expect(tableHtml).toContain('<strong>Cell 2</strong>');
  });

  it('does not nest lists or block elements inside paragraphs', () => {
    const mixedMd = `Intro text before list:
1. Item one
2. Item two
`;
    const mixedHtml = renderMarkdown(mixedMd);
    expect(/<p[^>]*>(?:(?!<\/p>)[\s\S])*?<ol/i.test(mixedHtml)).toBe(false);
    expect(mixedHtml).toContain('<p class="article-p">Intro text before list:</p>');
    expect(mixedHtml).toContain('<ol class="article-ol">');
  });

  it('keeps ordered list continuous with nested sub-bullets', () => {
    const nestedListMd = `
1. Step one
2. Step two
   - Sub bullet A
   - Sub bullet B
3. Step three
`;
    const nestedHtml = renderMarkdown(nestedListMd);
    const olMatches = nestedHtml.match(/<ol class="article-ol">/g) || [];
    expect(olMatches.length).toBe(1);
    expect(nestedHtml).toContain('<ul class="article-ul"><li>Sub bullet A</li><li>Sub bullet B</li></ul>');
  });

  it('renders external links with target="_blank" and internal links normally', () => {
    const linkMd = 'Check [LamaniHub](https://lamanihub.com) and [About](/what-is-synchronizer).';
    const linkHtml = renderMarkdown(linkMd);
    expect(linkHtml).toContain('<a href="https://lamanihub.com" class="article-link" target="_blank" rel="noopener noreferrer">LamaniHub</a>');
    expect(linkHtml).toContain('<a href="/what-is-synchronizer" class="article-link">About</a>');
  });
});

// markdown.ts - Lightweight, robust Markdown to HTML compiler for LamaniSync blog

export function renderMarkdown(content: string): string {
  let text = content.trim();

  // 1. Code blocks (extract before anything else)
  const codeBlocks: string[] = [];
  text = text.replace(/```([^\r\n]*)\r?\n([\s\S]*?)```/gm, (_match, lang, code) => {
    const placeholder = `___BLOCK_CODE_${codeBlocks.length}___`;
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const langAttr = lang && lang.trim() ? ` data-language="${lang.trim()}"` : '';
    codeBlocks.push(`<pre class="article-code"${langAttr}><code>${escaped}</code></pre>`);
    return `\n\n${placeholder}\n\n`;
  });

  // 2. Tables (extract before inline formatting)
  const tableBlocks: string[] = [];
  text = text.replace(/((?:\|[^\n]+\|\r?\n?)+)/g, (match) => {
    const lines = match.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return match;
    const placeholder = `___BLOCK_TABLE_${tableBlocks.length}___`;
    const parseCells = (row: string) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const headers = parseCells(lines[0]);
    const isSep = /^\|?(\s*:?-+:?\s*\|)+$/.test(lines[1]);
    const bodyRows = isSep ? lines.slice(2) : lines.slice(1);
    const thead = `<thead><tr>${headers.map((h) => `<th>${formatInline(h)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows.map((r) => `<tr>${parseCells(r).map((c) => `<td>${formatInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    tableBlocks.push(`<div class="table-container"><table class="article-table">${thead}${tbody}</table></div>`);
    return `\n\n${placeholder}\n\n`;
  });

  // Inline formatting helper
  function formatInline(str: string): string {
    let s = str;
    const inlines: string[] = [];
    // Inline code first to prevent inner formatting
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      const p = `___INLINE_CODE_${inlines.length}___`;
      const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      inlines.push(`<code class="inline-code">${esc}</code>`);
      return p;
    });
    // Markdown links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
      const isExt = url.startsWith('http') || url.startsWith('//');
      const targetRel = isExt ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${url}" class="article-link"${targetRel}>${linkText}</a>`;
    });
    // Bold & italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Restore inline code
    inlines.forEach((code, i) => {
      s = s.replace(`___INLINE_CODE_${i}___`, code);
    });
    return s;
  }

  const rawBlocks = text.split(/\n\s*\n/);
  const renderedParts: string[] = [];

  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Placeholders
    if (trimmed.startsWith('___BLOCK_CODE_') || trimmed.startsWith('___BLOCK_TABLE_')) {
      renderedParts.push(trimmed);
      continue;
    }

    // Horizontal Rule
    if (/^[-]{3,}$/.test(trimmed)) {
      renderedParts.push('<hr class="article-hr" />');
      continue;
    }

    // Headings
    if (/^###\s+(.*$)/.test(trimmed)) {
      renderedParts.push(`<h3 class="article-h3">${formatInline(trimmed.replace(/^###\s+/, ''))}</h3>`);
      continue;
    }
    if (/^##\s+(.*$)/.test(trimmed)) {
      renderedParts.push(`<h2 class="article-h2">${formatInline(trimmed.replace(/^##\s+/, ''))}</h2>`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteText = trimmed.split(/\r?\n/).map((l) => l.replace(/^>\s?/, '').trim()).join(' ');
      renderedParts.push(`<blockquote class="article-quote"><p>${formatInline(quoteText)}</p></blockquote>`);
      continue;
    }

    // List and Paragraph processing
    const lines = trimmed.split(/\r?\n/).map((l) => l.trimEnd());
    let currentParagraph: string[] = [];
    let olItems: { text: string; subBullets: string[] }[] = [];
    let ulItems: string[] = [];
    let inOl = false;
    let inUl = false;

    function flushParagraph() {
      if (currentParagraph.length > 0) {
        renderedParts.push(`<p class="article-p">${formatInline(currentParagraph.join('<br />'))}</p>`);
        currentParagraph = [];
      }
    }

    function flushOl() {
      if (olItems.length > 0) {
        let olHtml = '<ol class="article-ol">';
        for (const item of olItems) {
          olHtml += `<li>${formatInline(item.text)}`;
          if (item.subBullets && item.subBullets.length > 0) {
            olHtml += `<ul class="article-ul">${item.subBullets.map((b) => `<li>${formatInline(b)}</li>`).join('')}</ul>`;
          }
          olHtml += '</li>';
        }
        olHtml += '</ol>';
        renderedParts.push(olHtml);
        olItems = [];
        inOl = false;
      }
    }

    function flushUl() {
      if (ulItems.length > 0) {
        const ulHtml = `<ul class="article-ul">${ulItems.map((b) => `<li>${formatInline(b)}</li>`).join('')}</ul>`;
        renderedParts.push(ulHtml);
        ulItems = [];
        inUl = false;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      const olMatch = trimmedLine.match(/^(\d+)\.\s+(.*)$/);
      const isSubBullet = inOl && /^\s*[-*]\s+(.*)$/.test(line);
      const ulMatch = trimmedLine.match(/^[-*]\s+(.*)$/);

      if (olMatch) {
        flushParagraph();
        flushUl();
        inOl = true;
        olItems.push({ text: olMatch[2], subBullets: [] });
      } else if (isSubBullet && inOl && olItems.length > 0) {
        const bulletText = line.trim().replace(/^[-*]\s+/, '');
        olItems[olItems.length - 1].subBullets.push(bulletText);
      } else if (ulMatch && !inOl) {
        flushParagraph();
        inUl = true;
        ulItems.push(ulMatch[1]);
      } else {
        if (inOl) {
          if (/^\s{2,}/.test(line) && olItems.length > 0) {
            olItems[olItems.length - 1].text += ' ' + trimmedLine;
          } else {
            flushOl();
            currentParagraph.push(trimmedLine);
          }
        } else if (inUl) {
          flushUl();
          currentParagraph.push(trimmedLine);
        } else {
          currentParagraph.push(trimmedLine);
        }
      }
    }

    flushParagraph();
    flushOl();
    flushUl();
  }

  let finalHtml = renderedParts.join('\n');

  tableBlocks.forEach((tb, i) => {
    finalHtml = finalHtml.replace(`___BLOCK_TABLE_${i}___`, tb);
  });
  codeBlocks.forEach((cb, i) => {
    finalHtml = finalHtml.replace(`___BLOCK_CODE_${i}___`, cb);
  });

  return finalHtml;
}

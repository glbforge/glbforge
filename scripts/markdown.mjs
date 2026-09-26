/**
 * A deliberately small, strict Markdown -> HTML renderer.
 *
 * It exists so a page on glbforge.dev can be GENERATED from the Markdown in
 * `docs/` instead of being a hand-port of it that silently falls behind.
 * `site/budgets/index.html` documented `@2` as the current profile version
 * for days after `profiles.ts` published `@3`, never grew the v3 changelog
 * entry, and flattened every evidence table in the changelog out of
 * existence — all invisible, because nothing compared the two.
 *
 * Strict on purpose, and with no dependency: it renders exactly the
 * constructs the docs it generates from actually use, and THROWS on anything
 * else rather than guessing. A renderer that quietly drops a construct is the
 * hand-port's failure again, one step further from where anyone would look.
 * Adding a construct to a generated doc means teaching it here, on purpose.
 *
 * Supported: ATX headings (1-3), paragraphs, `-` and `1.` lists whose items
 * may contain further blocks (indent two spaces), pipe tables with a
 * delimiter row, and inline `code`, **strong**, *em*, [text](url), bare URLs.
 */

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SENTINEL = 'CODESPAN';

/**
 * Inline spans. Code is lifted out first, because a backtick span is
 * literal: `factor * texture` must not become emphasis, and a URL inside one
 * must not become a link.
 */
export function inline(text) {
  const code = [];
  let out = text.replace(/`([^`]+)`/g, (_, c) => {
    code.push(`<code>${escapeHtml(c)}</code>`);
    return `{{${SENTINEL}${code.length - 1}}}`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  // Bare URLs, but never one already inside an href="" written just above.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)"]+[^\s<)".,;:])/g, (_, lead, url) => `${lead}<a href="${url}">${url}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(—])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out.replace(new RegExp(`\\{\\{${SENTINEL}(\\d+)\\}\\}`, 'g'), (_, i) => code[Number(i)]);
}

const LIST_ITEM = /^(-|\d+\.)\s+(.*)$/;
const BLOCK_START = /^(#{1,3}\s|\||-\s|\d+\.\s)/;

/** Lines of one block-level region -> HTML. `at` is the source line number of lines[0], for errors. */
export function blocks(lines, at = 1) {
  const html = [];
  let i = 0;
  const lineNo = () => at + i;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      html.push(`<h${heading[1].length}>${inline(heading[2].trim())}</h${heading[1].length}>`);
      i++;
      continue;
    }

    if (line.startsWith('|')) {
      const rows = [];
      const start = lineNo();
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      html.push(table(rows, start));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const tag = LIST_ITEM.exec(line)[1] === '-' ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        if (!lines[i].trim()) {
          // A blank line ends the list unless what follows is still inside
          // it: the next item, or a block indented under the current one.
          const next = lines[i + 1] ?? '';
          if (!next.trim() || (!/^\s{2,}\S/.test(next) && !LIST_ITEM.test(next))) break;
          i++;
          continue;
        }
        const start = LIST_ITEM.exec(lines[i]);
        if (!start) break;
        const own = [start[2]];
        const startLine = lineNo();
        i++;
        while (i < lines.length && (!lines[i].trim() || /^\s{2,}\S/.test(lines[i]))) {
          if (!lines[i].trim() && !/^\s{2,}\S/.test(lines[i + 1] ?? '')) break;
          own.push(lines[i].replace(/^\s{2,}/, ''));
          i++;
        }
        items.push(listItem(own, startLine));
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (/^\s*(>|```|~~~)/.test(line)) {
      throw new Error(`markdown.mjs does not render this construct (line ${lineNo()}): ${line.trim().slice(0, 60)}`);
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return html.join('\n  ');
}

/** One list item. A single paragraph stays inline; anything richer nests blocks. */
function listItem(own, at) {
  const inner = blocks(own, at);
  const single = /^<p>([\s\S]*)<\/p>$/.exec(inner);
  return `<li>${single && !single[1].includes('<p>') ? single[1] : inner}</li>`;
}

function table(rows, at) {
  if (rows.length < 3) throw new Error(`table at line ${at} needs a header, a delimiter and at least one row`);
  const cells = (r) => r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  if (!/^\|[\s:|-]+\|?\s*$/.test(rows[1])) throw new Error(`table at line ${at} has no delimiter row`);
  const body = rows.slice(2).map((r, n) => {
    const c = cells(r);
    if (c.length !== head.length) throw new Error(`table row at line ${at + 2 + n} has ${c.length} cells, header has ${head.length}`);
    return `<tr>${c.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`;
  });
  return `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

/** A whole Markdown document -> HTML body content; `dropTitle` drops a leading `# ` heading. */
export function render(markdown, { dropTitle = false } = {}) {
  let lines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (dropTitle) {
    const first = lines.findIndex((l) => l.trim());
    if (first >= 0 && /^#\s/.test(lines[first])) lines = lines.slice(first + 1);
  }
  return blocks(lines, 1);
}

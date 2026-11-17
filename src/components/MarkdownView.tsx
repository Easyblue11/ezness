import { isValidElement, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightBlock } from '../lib/highlight';
import { prettyUrl } from '../lib/rag';
import type { CitationLink } from '../types';
import { CheckIcon, CopyIcon } from './Icons';

/**
 * GFM 自动链接只按空格断句：URL 紧贴中文全角标点或 `**` 时，会把标点和
 * 加粗标记一起吞进 href（点开就变成 /%EF%BC%88…）。这里在 AST 上把
 * 被吞掉的部分切回普通文本；`**URL**（…` 这种还原本成真正的加粗。
 */
type MdNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const AUTOLINK_BAD = /[（【「《》，。；：！？、）】」》*]/;

function fixAutolinkChildren(parent: MdNode): void {
  if (!Array.isArray(parent.children)) return;
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child?.type === 'link') index = fixAutolinkNode(parent, index);
    else fixAutolinkChildren(child);
  }
}

function fixAutolinkNode(parent: MdNode, index: number): number {
  const node = parent.children?.[index];
  if (!node) return index;
  const url = String(node.url ?? '');
  const text =
    node.children?.length === 1 && node.children[0].type === 'text'
      ? String(node.children[0].value ?? '')
      : '';
  // 只修自动链接（显示文字就是 URL）；普通 [文字](地址) 不动。
  if (!text || text !== url) return index;
  const bad = url.search(AUTOLINK_BAD);
  if (bad <= 0) return index;
  const clean = url.slice(0, bad);
  let rest = text.slice(clean.length);
  let wrapped: MdNode = node;

  // `**http://…/**（` 被解析成了「文字 + 被污染的链接」：把两头的 ** 还给
  // 链接，恢复成加粗，括号和后面的说明留在外面。
  if (rest.startsWith('**')) {
    const previous = parent.children?.[index - 1];
    if (previous?.type === 'text' && String(previous.value ?? '').endsWith('**')) {
      previous.value = String(previous.value).slice(0, -2);
      if (!previous.value) {
        parent.children?.splice(index - 1, 1);
        index -= 1;
      }
      rest = rest.slice(2);
      wrapped = { type: 'strong', children: [node] };
      if (parent.children) parent.children[index] = wrapped;
    }
  }

  node.url = clean;
  node.children = [{ type: 'text', value: clean }];
  if (rest && parent.children) {
    parent.children.splice(index + 1, 0, { type: 'text', value: rest });
  }
  return index + (rest ? 1 : 0);
}

function remarkFixAutolinks() {
  return (tree: MdNode) => fixAutolinkChildren(tree);
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const block = useMemo(() => highlightBlock(code, language), [code, language]);
  // A fence without a tag still gets coloured by detection; say so in the bar
  // instead of leaving it blank.
  const label = language || (block ? `${block.language}（自动识别）` : '纯文本');

  async function copy() {
    try {
      if (window.ezness?.copyText) await window.ezness.copyText(code);
      else await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — leave the button silent */
    }
  }

  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{label}</span>
        <button
          className={`md-code__copy ${copied ? 'is-copied' : ''}`}
          title={copied ? '已复制' : '复制代码'}
          aria-label="复制代码"
          onClick={copy}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      </div>
      <pre className="md-code__pre">
        {block === null ? (
          <code>{code}</code>
        ) : (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: block.html }} />
        )}
      </pre>
    </div>
  );
}

/** Cell text as it should appear inside a Markdown table row. */
function cellText(cell: HTMLTableCellElement): string {
  return cell.innerText
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Tables are wide by nature: the wrapper scrolls sideways instead of squeezing
 * every column into the bubble, and the bar copies the table back out as
 * Markdown (same shape as the message copy button).
 */
function TableBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);

  async function copy() {
    const table = tableRef.current;
    if (!table || table.rows.length === 0) return;

    const rows = [...table.rows].map((row) => [...row.cells].map(cellText));
    const header = rows[0];
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...rows.slice(1).map((cells) => `| ${cells.join(' | ')} |`),
    ];

    try {
      if (window.ezness?.copyText) await window.ezness.copyText(lines.join('\n'));
      else await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — leave the button silent */
    }
  }

  return (
    <div className="md-table">
      <div className="md-table__bar">
        <span className="md-table__label">表格</span>
        <button
          className={`md-table__copy ${copied ? 'is-copied' : ''}`}
          title={copied ? '已复制' : '复制表格（Markdown）'}
          aria-label="复制表格"
          onClick={copy}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      </div>
      <div className="md-table__scroll">
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  );
}

/** Internal link scheme for citation markers; never a real URL. */
const CITE_SCHEME = 'ezness-cite:';

const CITATION_MARKER =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)|\[(联网|资料)\s*(\d{1,3})\](?!\()/g;

/**
 * Turns [联网1] / [资料2] into Markdown links pointing at our internal scheme,
 * but only for labels we actually have a source for, and never inside code.
 */
function linkCitations(text: string, known: Map<string, CitationLink>): string {
  return text.replace(CITATION_MARKER, (match, code, kind, number) => {
    if (code) return code;
    const label = `${kind}${Number(number)}`;
    if (!known.has(label)) return match;
    return `[${label}](${CITE_SCHEME}${encodeURIComponent(label)})`;
  });
}

/**
 * Inline marker with a hover card. Web citations open the page on click;
 * knowledge-base citations only describe where the text came from (they have
 * no page to open).
 */
function CitationChip({ cite }: { cite: CitationLink }) {
  const openable = cite.kind === 'web' && Boolean(cite.url && /^https?:/i.test(cite.url));
  const open = () => {
    if (openable && cite.url) window.open(cite.url, '_blank');
  };
  const summary = `${cite.label}：${cite.title}${cite.detail ? `，${cite.detail}` : ''}`;

  return (
    <span
      className={`cite cite--${cite.kind}${openable ? ' is-openable' : ''}`}
      role={openable ? 'link' : undefined}
      tabIndex={0}
      aria-label={openable ? `${summary}（点击打开网页）` : summary}
      title={openable && cite.url ? prettyUrl(cite.url) : undefined}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
      onKeyDown={(event) => {
        if (!openable) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className="cite__mark">{cite.label}</span>
      <span className="cite__tip" role="tooltip">
        <span className="cite__tip-title">{cite.title}</span>
        {cite.kind === 'web' && cite.url ? (
          <span className="cite__tip-url">{prettyUrl(cite.url)}</span>
        ) : cite.detail ? (
          <span className="cite__tip-detail">{cite.detail}</span>
        ) : null}
        {openable ? <span className="cite__tip-hint">点击打开网页</span> : null}
      </span>
    </span>
  );
}

/**
 * Model output rendered as GitHub-flavoured Markdown. Raw HTML stays disabled
 * (react-markdown's default), so model text can't inject markup into the app.
 * Fenced code gets its own header bar (language + copy); the highlight output
 * is escaped by highlight.js, so `dangerouslySetInnerHTML` only ever receives
 * its own `<span class="hljs-*">` markup.
 */
export function MarkdownView({ text, citations }: { text: string; citations?: CitationLink[] }) {
  const byLabel = useMemo(() => {
    const map = new Map<string, CitationLink>();
    for (const cite of citations ?? []) map.set(cite.label, cite);
    return map;
  }, [citations]);

  const body = useMemo(
    () => (byLabel.size > 0 ? linkCitations(text, byLabel) : text),
    [text, byLabel],
  );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFixAutolinks]}
        // Only our internal scheme is preserved beyond the default allowlist;
        // every other URL still goes through defaultUrlTransform's filtering.
        urlTransform={(url) => (url.startsWith(CITE_SCHEME) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith(CITE_SCHEME)) {
              const label = decodeURIComponent(href.slice(CITE_SCHEME.length));
              const cite = byLabel.get(label);
              if (cite) return <CitationChip cite={cite} />;
            }
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href && /^https?:/i.test(href)) window.open(href, '_blank');
                }}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => <TableBlock>{children}</TableBlock>,
          pre: ({ children }) => {
            const first = Array.isArray(children) ? children[0] : children;
            if (!isValidElement<{ className?: string; children?: ReactNode }>(first)) {
              return <pre>{children}</pre>;
            }
            const language =
              /language-([\w+#.-]+)/i.exec(first.props.className ?? '')?.[1]?.toLowerCase() ?? '';
            const code = textOf(first.props.children).replace(/\n$/, '');
            return <CodeBlock code={code} language={language} />;
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

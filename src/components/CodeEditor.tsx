import { useMemo, useRef, useState, type UIEvent } from 'react';
import { highlightBlock } from '../lib/highlight';

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * A textarea with syntax colouring for the script editors.
 *
 * The textarea stays transparent and on top (so editing, selection, undo and
 * the IME all behave natively); a `<pre>` underneath shows the highlighted
 * copy and is scrolled in lockstep. While the IME is composing, the coloured
 * copy is hidden and the textarea shows its own text — the pre only updates on
 * `change`, so otherwise the candidate string would be invisible.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  rows = 12,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  /** highlight.js language name; '' auto-detects. */
  language: string;
  rows?: number;
  ariaLabel?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [composing, setComposing] = useState(false);
  const html = useMemo(() => {
    const block = highlightBlock(value, language);
    // A trailing newline keeps the last (empty) line inside the scroll area.
    return `${block ? block.html : escapeHtml(value)}\n`;
  }, [value, language]);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop = event.currentTarget.scrollTop;
    pre.scrollLeft = event.currentTarget.scrollLeft;
  }

  return (
    <div className={`code-editor ${composing ? 'is-composing' : ''}`}>
      <pre className="code-editor__pre" ref={preRef} aria-hidden="true">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <textarea
        className="input cap-dialog__textarea cap-dialog__code code-editor__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        rows={rows}
        spellCheck={false}
        aria-label={ariaLabel}
      />
    </div>
  );
}

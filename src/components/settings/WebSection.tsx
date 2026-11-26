import { useState } from 'react';
import { DEFAULT_WEB_ENTRIES, LOW_MATCH_NOTE, WEB_ENTRY_NAME_KEYS, webEntryId } from '../../data/web';
import { useI18n } from '../../i18n';
import type { WebEntry, WebParser, WebSettings } from '../../types';
import { GlobeIcon, PlusIcon, TrashIcon } from '../Icons';
import { WebModeSlider } from '../WebModeSlider';

const PARSER_KEY: Record<WebParser, string> = {
  bing: 'settings.web.parser.bing',
  so: 'settings.web.parser.so',
  baidu: 'settings.web.parser.baidu',
  shenma: 'settings.web.parser.shenma',
  quark: 'settings.web.parser.quark',
  duckduckgo: 'settings.web.parser.duckduckgo',
  html: 'settings.web.parser.html',
};

/** Built-in names are localised while the entry still carries its default name. */
function builtinName(entry: WebEntry): string {
  return DEFAULT_WEB_ENTRIES.find((item) => item.id === entry.id)?.name ?? '';
}

type TestState = {
  state: 'idle' | 'loading' | 'ok' | 'error';
  text?: string;
  notes?: string[];
  samples?: { title: string; url: string }[];
};

interface Props {
  web: WebSettings;
  onChange: (web: WebSettings) => void;
}

export function WebSection({ web, onChange }: Props) {
  const { t } = useI18n();
  const [probe, setProbe] = useState(() => t('settings.web.test.probeDefault'));
  const [test, setTest] = useState<TestState>({ state: 'idle' });

  const enabled = web.entries.filter((entry) => entry.enabled);

  function entryName(entry: WebEntry): string {
    const key = entry.builtin ? WEB_ENTRY_NAME_KEYS[entry.id] : undefined;
    return key && entry.name === builtinName(entry) ? t(key) : entry.name;
  }

  function patchEntry(id: string, patch: Partial<WebEntry>) {
    onChange({
      ...web,
      entries: web.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    });
    setTest({ state: 'idle' });
  }

  function removeEntry(id: string) {
    onChange({ ...web, entries: web.entries.filter((entry) => entry.id !== id) });
    setTest({ state: 'idle' });
  }

  function addEntry() {
    onChange({
      ...web,
      entries: [
        ...web.entries,
        {
          id: webEntryId(),
          name: t('settings.web.entry.customName', {
            count: web.entries.filter((entry) => !entry.builtin).length + 1,
          }),
          url: '',
          parser: 'html',
          enabled: true,
        },
      ],
    });
    setTest({ state: 'idle' });
  }

  async function runTest() {
    const api = window.ezness;
    const query = probe.trim();
    if (!api || !query) return;

    setTest({ state: 'loading', text: t('settings.web.test.running') });
    try {
      const result = await api.webSearch(query, enabled);
      if (!result.ok) {
        setTest({ state: 'error', text: result.error ?? t('settings.web.test.noResult') });
        return;
      }
      const results = result.results ?? [];
      const stats = (result.engines ?? [])
        .filter((engine) => engine.count > 0)
        .map((engine) => {
          const key = WEB_ENTRY_NAME_KEYS[engine.id];
          return t('settings.web.test.engineCount', {
            name: key ? t(key) : engine.name,
            count: engine.count,
          });
        })
        .join(' · ');
      setTest({
        state: 'ok',
        text: `${t('settings.web.test.summary', { count: results.length })}${
          stats ? ` · ${stats}` : ''
        }${result.weak ? ` ${t('settings.web.test.weak')}` : ''}`,
        // Entries that contributed nothing still matter: a captcha here is why a
        // source that used to work suddenly went quiet.
        // Backend notes carry this fixed marker; it is matched, never rendered.
        notes: (result.errors ?? []).filter((note) => !note.includes(LOW_MATCH_NOTE)),
        samples: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      });
    } catch (error) {
      setTest({ state: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.web.title')}</h2>
          <p>{t('settings.web.desc')}</p>
        </div>
        <span className="pill">
          <GlobeIcon size={12} />{' '}
          {t('settings.web.enabledCount', {
            enabled: enabled.length,
            total: web.entries.length,
          })}
        </span>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <GlobeIcon size={15} />
          {t('settings.web.default.title')}
        </div>
        <p className="kb-card__desc">{t('settings.web.default.desc')}</p>
        <WebModeSlider
          value={web.defaultMode}
          onChange={(defaultMode) => onChange({ ...web, defaultMode })}
        />
      </section>

      {enabled.length === 0 && (
        <div className="notice notice--warn">{t('settings.web.none')}</div>
      )}

      <section className="kb-card">
        <div className="kb-card__title">
          <GlobeIcon size={15} />
          {t('settings.web.url.title')}
        </div>
        <p className="kb-card__desc">
          {t('settings.web.url.desc1')} <code>{'{query}'}</code>
          {t('settings.web.url.desc2')}
        </p>

        <div className="web-list">
          {web.entries.map((entry) => {
            const badUrl = entry.enabled && entry.url.trim() !== '' && !/\{query\}/i.test(entry.url);
            const emptyUrl = entry.enabled && entry.url.trim() === '';
            return (
              <div key={entry.id} className={`web-entry ${entry.enabled ? '' : 'is-off'}`}>
                <div className="web-entry__head">
                  <button
                    className={`switch ${entry.enabled ? 'is-on' : ''}`}
                    title={
                      entry.enabled ? t('settings.web.entry.onTitle') : t('settings.web.entry.offTitle')
                    }
                    aria-pressed={entry.enabled}
                    onClick={() => patchEntry(entry.id, { enabled: !entry.enabled })}
                  >
                    <span />
                  </button>
                  <input
                    className="input web-entry__name"
                    value={entryName(entry)}
                    placeholder={t('settings.web.entry.namePlaceholder')}
                    onChange={(event) => patchEntry(entry.id, { name: event.target.value })}
                  />
                  <span className="web-entry__tag">
                    {entry.builtin
                      ? t('settings.web.entry.builtin')
                      : t('settings.web.entry.custom')}{' '}
                    · {t(PARSER_KEY[entry.parser] ?? PARSER_KEY.html)}
                  </span>
                  {!entry.builtin && (
                    <button
                      className="iconbtn"
                      title={t('settings.web.entry.remove')}
                      onClick={() => removeEntry(entry.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                </div>
                <input
                  className="input web-entry__url"
                  value={entry.url}
                  placeholder="https://example.com/search?q={query}"
                  spellCheck={false}
                  onChange={(event) => patchEntry(entry.id, { url: event.target.value })}
                />
                {emptyUrl && (
                  <div className="web-entry__hint">{t('settings.web.entry.emptyUrl')}</div>
                )}
                {badUrl && (
                  <div className="web-entry__hint web-entry__hint--warn">
                    {t('settings.web.entry.badUrlBefore')} <code>{'{query}'}</code>
                    {t('settings.web.entry.badUrlAfter')}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="kb-card__row">
          <button className="btn" onClick={addEntry}>
            <PlusIcon size={14} />
            {t('settings.web.entry.add')}
          </button>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.web.test.title')}</div>
        <p className="kb-card__desc">{t('settings.web.test.desc')}</p>
        <div className="kb-card__row">
          <input
            className="input"
            value={probe}
            placeholder={t('settings.web.test.placeholder')}
            onChange={(event) => setProbe(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runTest();
            }}
          />
          <button
            className="btn btn--primary"
            disabled={test.state === 'loading' || enabled.length === 0 || !probe.trim()}
            onClick={() => void runTest()}
          >
            {test.state === 'loading'
              ? t('settings.web.test.searching')
              : t('settings.web.test.button')}
          </button>
        </div>

        {test.state === 'error' && <div className="notice notice--warn">{test.text}</div>}
        {test.state === 'ok' && (
          <>
            <div className="kb-card__meta">{test.text}</div>
            {test.notes && test.notes.length > 0 && (
              <div className="web-entry__hint">
                {t('settings.web.test.notesRejected', {
                  notes: test.notes.join(t('settings.web.test.notesJoin')),
                })}
              </div>
            )}
            {test.samples && test.samples.length > 0 && (
              <ul className="web-samples">
                {test.samples.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

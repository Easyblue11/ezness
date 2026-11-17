import { useState } from 'react';
import { webEntryId } from '../../data/web';
import type { WebEntry, WebParser, WebSettings } from '../../types';
import { GlobeIcon, PlusIcon, TrashIcon } from '../Icons';
import { WebModeSlider } from '../WebModeSlider';

const PARSER_LABEL: Record<WebParser, string> = {
  bing: 'Bing 结果页',
  so: '360 结果页',
  baidu: '百度结果页',
  shenma: '神马结果页',
  quark: '夸克结果页',
  duckduckgo: 'DuckDuckGo Lite',
  html: '通用 HTML',
};

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
  const [probe, setProbe] = useState('今天的新闻');
  const [test, setTest] = useState<TestState>({ state: 'idle' });

  const enabled = web.entries.filter((entry) => entry.enabled);

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
          name: `自定义入口 ${web.entries.filter((entry) => !entry.builtin).length + 1}`,
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

    setTest({ state: 'loading', text: '正在向启用的入口并发请求…' });
    try {
      const result = await api.webSearch(query, enabled);
      if (!result.ok) {
        setTest({ state: 'error', text: result.error ?? '没有拿到结果' });
        return;
      }
      const results = result.results ?? [];
      const stats = (result.engines ?? [])
        .filter((engine) => engine.count > 0)
        .map((engine) => `${engine.name} ${engine.count} 条`)
        .join(' · ');
      setTest({
        state: 'ok',
        text: `汇总 ${results.length} 条结果${stats ? ` · ${stats}` : ''}${
          result.weak ? ' · 匹配度偏低，仅作参考' : ''
        }`,
        // Entries that contributed nothing still matter: a captcha here is why a
        // source that used to work suddenly went quiet.
        notes: (result.errors ?? []).filter((note) => !/结果与问题不匹配/.test(note)),
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
          <h2>网络设置</h2>
          <p>
            联网检索时，下面每个被激活的入口都会在本地并发请求一次，结果去重后一起交给模型。
            请求全部在本机主进程发出，不经过模型厂商。
          </p>
        </div>
        <span className="pill">
          <GlobeIcon size={12} /> {enabled.length} / {web.entries.length} 已启用
        </span>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <GlobeIcon size={15} />
          默认联网方式
        </div>
        <p className="kb-card__desc">
          新对话和新任务从这里取初始状态；每条对话里的「联网」仍然可以单独调整。
          自动模式会先让 AI 判断消息是否需要最新信息，只在需要时检索——寒暄和通用问题不会触发搜索。
        </p>
        <WebModeSlider
          value={web.defaultMode}
          onChange={(defaultMode) => onChange({ ...web, defaultMode })}
        />
      </section>

      {enabled.length === 0 && (
        <div className="notice notice--warn">
          现在没有任何入口是激活的。开着「联网」发送消息时不会检索网页——至少打开一个。
        </div>
      )}

      <section className="kb-card">
        <div className="kb-card__title">
          <GlobeIcon size={15} />
          搜索地址
        </div>
        <p className="kb-card__desc">
          地址里的 <code>{'{query}'}</code> 会被替换成已编码的问题。内置入口按各自的结果页结构解析；
          自定义入口按「标题链接」通用规则提取，适合简单的结果页。
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
                    title={entry.enabled ? '已激活，联网时会请求' : '未激活，联网时跳过'}
                    aria-pressed={entry.enabled}
                    onClick={() => patchEntry(entry.id, { enabled: !entry.enabled })}
                  >
                    <span />
                  </button>
                  <input
                    className="input web-entry__name"
                    value={entry.name}
                    placeholder="入口名称"
                    onChange={(event) => patchEntry(entry.id, { name: event.target.value })}
                  />
                  <span className="web-entry__tag">
                    {entry.builtin ? '内置' : '自定义'} · {PARSER_LABEL[entry.parser] ?? '通用 HTML'}
                  </span>
                  {!entry.builtin && (
                    <button
                      className="iconbtn"
                      title="删除这个入口"
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
                  <div className="web-entry__hint">还没有填地址，联网时这个入口会被跳过。</div>
                )}
                {badUrl && (
                  <div className="web-entry__hint web-entry__hint--warn">
                    地址里缺少 <code>{'{query}'}</code>，联网时这个入口会被跳过。
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="kb-card__row">
          <button className="btn" onClick={addEntry}>
            <PlusIcon size={14} />
            新增入口
          </button>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">试一下</div>
        <p className="kb-card__desc">
          用当前激活的入口真实请求一次，检查是否能解析出结果、各入口贡献了多少。不会调用模型。
        </p>
        <div className="kb-card__row">
          <input
            className="input"
            value={probe}
            placeholder="输入一个测试问题"
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
            {test.state === 'loading' ? '检索中…' : '测试所有入口'}
          </button>
        </div>

        {test.state === 'error' && <div className="notice notice--warn">{test.text}</div>}
        {test.state === 'ok' && (
          <>
            <div className="kb-card__meta">{test.text}</div>
            {test.notes && test.notes.length > 0 && (
              <div className="web-entry__hint">未采用：{test.notes.join('；')}</div>
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

import { useEffect, useState } from 'react';
import { CloseIcon, MinusIcon, SquareIcon } from './Icons';

export function TitleBar() {
  const api = window.ezness;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.isMaximized().then(setMaximized);
    return api.onWindowState(setMaximized);
  }, [api]);

  return (
    <header className="titlebar">
      <div className="titlebar__drag">
        <div className="titlebar__brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Ezness</span>
        </div>
        <span className="titlebar__tag">v{__APP_VERSION__}</span>
      </div>

      {api && (
        <div className="titlebar__controls">
          <button className="winbtn" title="最小化" onClick={() => api.minimize()}>
            <MinusIcon size={14} />
          </button>
          <button className="winbtn" title={maximized ? '还原' : '最大化'} onClick={() => api.toggleMaximize()}>
            <SquareIcon size={12} />
          </button>
          <button className="winbtn winbtn--close" title="关闭" onClick={() => api.close()}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}
    </header>
  );
}

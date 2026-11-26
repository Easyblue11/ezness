import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { CloseIcon, MinusIcon, SquareIcon } from './Icons';

export function TitleBar() {
  const { t } = useI18n();
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
          <button className="winbtn" title={t('titlebar.minimize')} onClick={() => api.minimize()}>
            <MinusIcon size={14} />
          </button>
          <button
            className="winbtn"
            title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
            onClick={() => api.toggleMaximize()}
          >
            <SquareIcon size={12} />
          </button>
          <button className="winbtn winbtn--close" title={t('titlebar.close')} onClick={() => api.close()}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}
    </header>
  );
}

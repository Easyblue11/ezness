import { useEffect, useState } from 'react';
import type { WorkSettings } from '../../types';
import { AskLevelSlider } from '../AskLevelSlider';
import { DownloadIcon, WorkspaceIcon } from '../Icons';

interface Props {
  work: WorkSettings;
  onChange: (work: WorkSettings) => void;
}

export function WorkSection({ work, onChange }: Props) {
  // Keep the raw text while typing so clearing the box does not snap to 1.
  const [draft, setDraft] = useState(String(work.maxSteps));

  useEffect(() => {
    setDraft(String(work.maxSteps));
  }, [work.maxSteps]);

  const unlimited = work.maxSteps === -1;

  function commit(raw: string) {
    const value = Math.trunc(Number(raw));
    if (raw.trim() === '' || !Number.isFinite(value)) return;
    onChange({ ...work, maxSteps: value === -1 ? -1 : Math.max(1, value) });
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>工作设置</h2>
          <p>
            工作空间里任务执行时的通用限制。改动会立即用于下一个新任务，正在跑的任务不受影响。
          </p>
        </div>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          单轮工具调用步数
        </div>
        <p className="kb-card__desc">
          模型在一次任务里连续调用工具（读文件、改文件、执行命令）的步数上限。
          达到上限会停下并提示，继续发消息可以接着做。
        </p>
        <div className="kb-card__row work-row">
          <input
            className="input"
            style={{ maxWidth: 160 }}
            type="number"
            min={-1}
            step={1}
            value={draft}
            aria-label="单轮工具调用步数"
            onChange={(event) => {
              setDraft(event.target.value);
              commit(event.target.value);
            }}
            onBlur={() => setDraft(String(work.maxSteps))}
          />
          <span className="kb-card__meta">
            {unlimited ? '不限制步数' : `最多 ${work.maxSteps} 步`}
          </span>
        </div>
        <div className="field__hint">
          默认 24 步；填 -1 表示不限制。大范围重构、逐文件检查这类任务建议调高或设为 -1。
        </div>
      </section>

      <section className="kb-card work-ask">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          问询级别
        </div>
        <p className="kb-card__desc">
          代理执行任务时多久停下来问你一次。级别越高问得越勤，越低越放手。
          这是新任务的默认值，每个任务也可以在输入框下方的「问询」按钮里单独调整。
          自动只取消询问，不会改变权限模式的限制；破坏性命令会先交给独立 AI 评估，评估认为有风险时由你决定是否执行。
        </p>
        <AskLevelSlider
          value={work.askLevel}
          onChange={(askLevel) => onChange({ ...work, askLevel })}
        />
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          临时文件
        </div>
        <p className="kb-card__desc">
          代理执行任务时产生的脚本、日志、截图、中间数据这类用完即弃的文件，
          统一放在工作空间根目录的 <code>.ezness</code> 文件夹里，不会和项目文件混在一起。
        </p>
        <div className="kb-card__row work-row">
          <button
            className={`switch ${work.autoDeleteTemp ? 'is-on' : ''}`}
            role="switch"
            aria-checked={work.autoDeleteTemp}
            aria-label="自动删除 AI 临时输出文件"
            title={work.autoDeleteTemp ? '任务结束后自动删除' : '保留临时文件'}
            onClick={() => onChange({ ...work, autoDeleteTemp: !work.autoDeleteTemp })}
          >
            <span />
          </button>
          <span className="kb-card__meta">
            {work.autoDeleteTemp
              ? '当前激活状态：自动删除 AI 临时文件'
              : '当前激活状态：保留 AI 临时文件'}
          </span>
        </div>
        <div className="field__hint">
          只会删除工作空间根目录下 <code>.ezness</code> 文件夹里的内容；
          代理为你新建或修改的项目文件不受影响。
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <DownloadIcon size={15} />
          自动安装依赖
        </div>
        <p className="kb-card__desc">
          AI能力里的脚本用到的第三方库（Python 的 pip 包、Node 的 npm 包），在保存测试和第一次运行时
          自动装好，不需要你开终端手动安装。Python 包装进数据目录里的独立环境，Node 包装进数据目录的
          agent 目录，都不会改动系统环境。
        </p>
        <div className="kb-card__row work-row">
          <button
            className={`switch ${work.autoInstallDeps ? 'is-on' : ''}`}
            role="switch"
            aria-checked={work.autoInstallDeps}
            aria-label="自动安装AI能力的依赖"
            title={work.autoInstallDeps ? '缺包时自动安装' : '缺包时不自动安装'}
            onClick={() => onChange({ ...work, autoInstallDeps: !work.autoInstallDeps })}
          >
            <span />
          </button>
          <span className="kb-card__meta">
            {work.autoInstallDeps
              ? '当前激活状态：自动安装依赖'
              : '当前激活状态：不自动安装依赖'}
          </span>
        </div>
        <div className="field__hint">
          关闭后，缺包的脚本会在测试时失败并指出缺哪个包；Python 包仍可在「设置 → 程序环境」里手动安装。
        </div>
      </section>
    </div>
  );
}

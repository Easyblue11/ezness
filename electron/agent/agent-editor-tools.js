/**
 * Tools available only inside an Agent编辑-<hash> workspace.
 *
 * The model can inspect and change exactly one Agent definition, and nothing
 * else. These tools are never added to the normal registry, so a regular
 * workspace cannot call them, and an agent-editor run cannot see file,
 * command, network or custom-tool capabilities.
 *
 * Saving is immediate: an update writes agents.json right away. The Agent
 * page re-reads the list the next time it becomes visible.
 */

const uiText = require('../ui-text');

let bridge = null;

function setAgentEditorBridge(next) {
  bridge = next && typeof next === 'object' ? next : null;
}

function scopeOf(ctx) {
  const scope = ctx?.toolScope;
  if (!scope || scope.kind !== 'agent-editor' || !scope.agentId) {
    throw new Error(uiText.t('main.agent.errNoAgentScope'));
  }
  return scope;
}

function call(method, ctx, payload) {
  const scope = scopeOf(ctx);
  if (!bridge || typeof bridge[method] !== 'function') {
    throw new Error(uiText.t('main.agent.errAgentEditorUnavailable'));
  }
  return bridge[method](scope, payload ?? {});
}

const TOOLS = [
  {
    name: 'agent_editor_get',
    description:
      '读取当前 Agent 的完整定义、可绑定的内置/自定义能力分类。修改前先调用它了解现状。',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    agentEditor: true,
    async run(ctx) {
      return call('get', ctx);
    },
  },
  {
    name: 'agent_editor_update',
    description:
      '修改当前 Agent 的定义并立即保存到 agents.json。changes 只需给出要改的字段：name、role、personality、inputSpec、outputSpec、prompt、enabled、capabilities。capabilities 形如 {mode:"all"|"selected", builtin:[内置分类名], custom:[自定义分类名或 id]}；分类必须来自 agent_editor_get 列出的范围。',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'object',
          description:
            '要修改的字段。capabilities 会整体替换当前能力范围：mode 为 all 时忽略 builtin/custom；为 selected 时列出要启用的分类。',
        },
      },
      required: ['changes'],
    },
    agentEditor: true,
    async run(ctx, args) {
      return call('update', ctx, { changes: args?.changes });
    },
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function specs() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function get(name) {
  return byName.get(name) ?? null;
}

module.exports = { TOOLS, specs, get, setAgentEditorBridge };

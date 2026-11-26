/**
 * Tools available only inside a 功能编辑-<分类> workspace.
 *
 * The model can inspect and change tools of the category the workspace is
 * bound to, and nothing else. These tools are never added to the normal
 * registry, so a regular workspace cannot call them, and a tool-editor run
 * cannot see read_file / write_file / run_command or any custom tool.
 */

const uiText = require('../ui-text');

let bridge = null;

function setToolEditorBridge(next) {
  bridge = next && typeof next === 'object' ? next : null;
}

function scopeOf(ctx) {
  const scope = ctx?.toolScope;
  if (!scope || scope.kind !== 'tool-editor' || !scope.categoryId) {
    throw new Error(uiText.t('main.agent.errNoCategoryScope'));
  }
  return scope;
}

function call(method, ctx, payload) {
  const scope = scopeOf(ctx);
  if (!bridge || typeof bridge[method] !== 'function') {
    throw new Error(uiText.t('main.agent.errToolEditorUnavailable'));
  }
  return bridge[method](scope, payload ?? {});
}

const TOOLS = [
  {
    name: 'tool_editor_list',
    description:
      '列出当前功能分类的信息和全部功能（名称、说明、参数、运行时、只读、权限、健康状态、最近错误）。修改前先调用它了解现状。',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    toolEditor: true,
    async run(ctx) {
      return call('list', ctx);
    },
  },
  {
    name: 'tool_editor_get',
    description:
      '读取当前分类中指定功能的完整定义（包括脚本和权限策略）。修改某个功能前先用它确认原文。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '当前分类中的功能名称' },
      },
      required: ['name'],
    },
    readOnly: true,
    toolEditor: true,
    async run(ctx, args) {
      return call('get', ctx, { name: String(args?.name ?? '') });
    },
  },
  {
    name: 'tool_editor_create',
    description:
      '在当前分类新增一个功能。必须提供完整 definition 和 testArgs；保存前会自动安装 definition.dependencies 里声明的第三方包，然后做语法检查和冒烟测试，测试不通过的功能会被保留为故障状态但不会启用。一个任务需要多个步骤时，拆成多个功能分别创建。',
    parameters: {
      type: 'object',
      properties: {
        definition: {
          type: 'object',
          description:
            '完整定义：name, description, runtime(node|python|executable), script, command, cwd, timeoutMs, readOnly, network, policy, parameters, dependencies。parameters 每项 {name, type(string|number|boolean), required, description, default?}；非必填参数一定要用 default 声明 defaultValue（例如端口 443、并发 3000、开关 true），平台会在调用方没传时填进去，不要只在 description 里写「默认 xxx」。dependencies 是第三方包名数组（Python 用 pip 包名，例如 requests、pandas==2.2.3；Node 用 npm 包名，例如 axios）；系统会自动安装，不要让用户手动安装。分类由系统强制写入，不要传。',
        },
        testArgs: {
          type: 'object',
          description:
            '冒烟测试参数，键是参数名。有必填参数时必须提供；没有 default 的非必填参数也要给出测试值，否则脚本收到的是空字符串。',
        },
      },
      required: ['definition'],
    },
    toolEditor: true,
    async run(ctx, args) {
      return call('create', ctx, {
        definition: args?.definition,
        testArgs: args?.testArgs,
      });
    },
  },
  {
    name: 'tool_editor_update',
    description:
      '修改当前分类中已有的功能。changes 只需给出要改的字段；合并后会重新做语法检查和冒烟测试。测试不通过时不会覆盖旧版本。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要修改的功能名称' },
        changes: {
          type: 'object',
          description:
            '要修改的字段，例如 description, script, command, parameters, readOnly, network, policy, timeoutMs, dependencies；也可以用 name 改名。新增第三方包时同时更新 dependencies，系统会自动安装。',
        },
        testArgs: {
          type: 'object',
          description: '冒烟测试参数。修改涉及参数时建议提供。',
        },
      },
      required: ['name', 'changes'],
    },
    toolEditor: true,
    async run(ctx, args) {
      return call('update', ctx, {
        name: String(args?.name ?? ''),
        changes: args?.changes,
        testArgs: args?.testArgs,
      });
    },
  },
  {
    name: 'tool_editor_delete',
    description:
      '删除当前分类中的一个功能。删除前用户会看到确认卡片；只有这个分类里的功能可以删除。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要删除的功能名称' },
      },
      required: ['name'],
    },
    toolEditor: true,
    ask: true,
    async run(ctx, args) {
      return call('delete', ctx, { name: String(args?.name ?? '') });
    },
  },
  {
    name: 'tool_editor_test',
    description:
      '重新运行当前分类中某个功能的语法检查和冒烟测试，并更新它的健康状态。修复后用它确认功能能否启用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要测试的功能名称' },
        args: { type: 'object', description: '测试参数，键是参数名' },
      },
      required: ['name'],
    },
    toolEditor: true,
    async run(ctx, args) {
      return call('test', ctx, {
        name: String(args?.name ?? ''),
        args: args?.args,
      });
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

module.exports = { TOOLS, specs, get, setToolEditorBridge };

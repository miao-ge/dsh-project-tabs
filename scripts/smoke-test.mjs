/**
 * dsh-project-tabs 的离线冒烟测试（不需要浏览器、不需要联网、不需要 React 包）。
 *
 * 覆盖：
 *   1. bundle 能被 __ModuleLoader__.load 解析，id / 导出 / inject 正确；
 *   2. package.json 满足 0.2.0 对外部客户端插件的硬性要求；
 *   3. apply(ctx) 的接线：注册进 shell.overlay、装样式表、提供 projectTabs 服务；
 *   4. 标签 store 的全部动作（open / select / reassign / close / closeMany / move）；
 *   5. 组件渲染出来的元素树：标签数量、active、项目名、状态点映射、关闭与切换回调。
 *
 * 做法：用一个迷你 hook 运行时“渲染”一次组件（不 flush effects，保持确定性），
 * 把 react/jsx-runtime 的产物当成普通 `{type, props}` 对象树来断言；
 * DOM 借本机 DSH 里的 @mixmark-io/domino。
 *
 * 用法：node tabs/scripts/smoke-test.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/* ------------------------------------------------------------------ domino */

function resolveDomino() {
  const candidates = [
    process.env.DSH_DOMINO,
    'H:/node/node_global/node_modules/@deepseek-ai/dsh/node_modules/@mixmark-io/domino',
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@mixmark-io', 'domino'),
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@mixmark-io', 'domino'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'domino';
}

const domino = require(resolveDomino());
const win = domino.createWindow('<!doctype html><html><body></body></html>');
const doc = win.document;

/** domino 的 window 上有几个属性是只读的，这里只补真正缺的。 */
function define(target, name, value) {
  try {
    target[name] = value;
  } catch {
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    } catch {
      /* 真的改不动就跳过：插件读的是 bare 标识符，走 globalThis 那份 */
    }
  }
}

define(win, 'innerWidth', 1600);
define(win, 'innerHeight', 900);
define(win, 'setTimeout', globalThis.setTimeout);
define(win, 'clearTimeout', globalThis.clearTimeout);

class FakeObserver { observe() {} unobserve() {} disconnect() {} }

globalThis.window = win;
globalThis.document = doc;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = FakeObserver;
globalThis.MutationObserver = FakeObserver;
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
globalThis.cancelAnimationFrame = () => {};
define(doc, 'fonts', { ready: Promise.resolve() });
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

/* --------------------------------------------------- 迷你 React / 假模块 */

/** 渲染用的 hook 帧栈：每个函数组件一层，避免嵌套组件的 hook 索引串味。 */
const mini = {
  stack: [{ slots: [], index: 0 }],
  effects: [],
  frame() {
    return this.stack[this.stack.length - 1];
  },
  reset() {
    this.stack = [{ slots: [], index: 0 }];
    this.effects = [];
  },
};

/**
 * 顶层渲染：保留 hook 槽（状态），只把游标归零——就像 React 每次重渲染那样。
 * @param component - 顶层组件。
 * @param props - 组件 props。
 * @returns 元素树。
 */
function renderRoot(component, props) {
  const slots = mini.stack.length > 0 ? mini.stack[0].slots : [];
  mini.stack = [{ slots, index: 0 }];
  mini.effects = [];
  return component(props);
}

/** 跑一遍刚收集的副作用；返回它们的清理函数集合。 */
function flushEffects() {
  const cleanups = [];
  for (const effect of mini.effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* 清理失败不影响断言 */ }
    }
  };
}

const Fragment = Symbol('Fragment');

/** 依赖数组比较：都没给，或长度相同且逐项 Object.is。 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

const React = {
  useState(initial) {
    const frame = mini.frame();
    const at = frame.index++;
    if (!(at in frame.slots)) frame.slots[at] = typeof initial === 'function' ? initial() : initial;
    return [frame.slots[at], (value) => {
      frame.slots[at] = typeof value === 'function' ? value(frame.slots[at]) : value;
    }];
  },
  useRef(initial) {
    const frame = mini.frame();
    const at = frame.index++;
    if (!(at in frame.slots)) frame.slots[at] = { current: initial };
    return frame.slots[at];
  },
  useMemo(factory, deps) {
    const frame = mini.frame();
    const at = frame.index++;
    const slot = frame.slots[at];
    if (slot !== undefined && sameDeps(slot[1], deps)) return slot[0];
    const value = factory();
    frame.slots[at] = [value, deps];
    return value;
  },
  useCallback(callback, deps) {
    const frame = mini.frame();
    const at = frame.index++;
    const slot = frame.slots[at];
    if (slot !== undefined && sameDeps(slot[1], deps)) return slot[0];
    frame.slots[at] = [callback, deps];
    return callback;
  },
  useEffect(effect) {
    mini.frame().index += 1;
    mini.effects.push(effect);
  },
  useLayoutEffect(effect) {
    mini.frame().index += 1;
    mini.effects.push(effect);
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    mini.frame().index += 1;
    return getSnapshot();
  },
};

const jsxRuntime = {
  Fragment,
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
};

/** 官方组件的最小替身：只保留足够断言的结构。 */
const primitives = {
  Menu: 'Menu',
  StateDot: 'StateDot',
  IconPlusOutlineRegular: 'IconPlus',
  IconCloseFillRegular: 'IconClose',
  IconFolderCloseRegular: 'IconFolder',
};

/** dsh-client-store 的等价实现（深拷贝 draft + 全量替换，够本插件用）。 */
function defineStore(declaration) {
  return {
    spec: declaration,
    create() {
      let state = declaration.init();
      const listeners = new Set();
      const actions = {};
      for (const key of Object.keys(declaration.actions)) {
        actions[key] = (...params) => {
          const draft = structuredClone(state);
          declaration.actions[key](draft, ...params);
          state = draft;
          for (const listener of [...listeners]) listener();
        };
      }
      return {
        actions,
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}

const modules = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
  '@deepseek-ai/dsh-client-store': { defineStore },
};

/* ------------------------------------------------------------ 加载 bundle */

const source = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
let entry = null;
win.__ModuleLoader__ = { load: (value) => { entry = value; } };
vm.runInThisContext(source, { filename: 'tabs/lib/client.js' });

/* ------------------------------------------------------------ 断言工具 */

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  (${detail})`}`);
    failures.push(name);
  }
}

const isElement = (value) => value !== null && typeof value === 'object' && 'type' in value && 'props' in value;

/** 深度优先收集元素节点；函数组件会被展开（各自一层 hook 帧）。 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isElement(node)) return;
  if (typeof node.type === 'function') {
    mini.stack.push({ slots: [], index: 0 });
    let rendered = null;
    try {
      rendered = node.type(node.props);
    } finally {
      mini.stack.pop();
    }
    walk(rendered, visit);
    return;
  }
  visit(node);
  /* Menu 的触发元素走 anchor prop，不在 children 里，也要能遍历到。 */
  if (node.props.anchor !== undefined && node.props.anchor !== null) walk(node.props.anchor, visit);
  walk(node.props.children, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isElement(node)) return '';
  return textOf(node.props.children);
}

/* ------------------------------------------------------------ 1. 模块加载 */

console.log('1) 模块加载与清单');
check('__ModuleLoader__.load 被调用且 id 正确', entry !== null && entry.id === 'dsh-project-tabs');
const mod = entry === null ? {} : entry.factory((name) => {
  if (name in modules) return modules[name];
  throw new Error(`测试替身缺少模块：${name}`);
});
check('导出 apply 函数', typeof mod.apply === 'function');
check('inject 覆盖用到的服务', Array.isArray(mod.inject)
  && ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions'].every((key) => mod.inject.includes(key)));

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
check('dsh.client.platform === "web"', manifest.dsh?.client?.platform === 'web');
check('dsh.bundle.patch 已声明', typeof manifest.dsh?.bundle?.patch === 'string');
check('exports["./client"] 指向 lib/client.js', manifest.exports?.['./client']?.default === './lib/client.js');
check('exports["."] 指向 lib/index.js', manifest.exports?.['.']?.default === './lib/index.js');

/* ------------------------------------------------------------ 2. apply 接线 */

console.log('2) apply(ctx) 接线');
const registered = [];
const effects = [];
const provided = [];
const opened = [];
const connected = [];
const retained = [];

const ctx = {
  effect: (callback, label) => {
    const dispose = callback();
    effects.push({ label, dispose });
    return () => {};
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  reflect: {
    provide: (name, value) => {
      provided.push({ name, value });
      return () => {};
    },
  },
  slots: {
    inject: (key, callback) => {
      callback();
      return () => {};
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
  uiWorkspace: {
    openSession: (sessionId) => { opened.push(sessionId); },
    connectWorkspace: async (workspaceId) => { connected.push(workspaceId); return `session-of-${workspaceId}`; },
    pickDirectory: async () => null,
  },
  workspaces: { create: async ({ path }) => ({ workspaceId: `ws:${path}` }) },
  sessions: { retain: (sessionId) => { retained.push(sessionId); return { release() {} }; } },
};

let applyThrew = null;
try {
  mod.apply(ctx);
} catch (error) {
  applyThrew = error;
}
check('apply 不抛异常', applyThrew === null, applyThrew?.message);

const registration = registered[0];
check('注册进 shell.overlay', registration?.options?.name === 'shell.overlay');
check('注册 id 为 project-tabs', registration?.options?.id === 'project-tabs');
check('注册带 locale', registration?.options?.locale === 'project-tabs');
check('注册了组件', typeof registration?.component === 'function');
check('装了样式表', doc.querySelector('style[data-plugin-css="dsh-project-tabs/bar.css"]') !== null);
check('提供了 projectTabs 服务', provided.some((item) => item.name === 'projectTabs'));
check('挂了 window 兜底', typeof globalThis.__DSH_PROJECT_TABS__ === 'object');

const injectFace = registration.options.inject === undefined ? null : registration.options.inject();
check('inject 面暴露 tabsStore', injectFace !== null && typeof injectFace.tabsStore?.getSnapshot === 'function');
check('inject 面暴露 retainSession', typeof injectFace?.retainSession === 'function');

/* ------------------------------------------------------------ 3. store 动作 */

console.log('3) 标签 store 动作');
const store = injectFace.tabsStore;
const actions = store.actions;

actions.open('s1');
actions.open('s2');
actions.open('s3');
check('open 依次追加并选中新标签', store.getSnapshot().tabs.map((tab) => tab.sessionId).join(',') === 's1,s2,s3'
  && store.getSnapshot().activeTabId === store.getSnapshot().tabs[2].id);

actions.open('s1');
check('open 已存在的会话只切选中、不重复加', store.getSnapshot().tabs.length === 3
  && store.getSnapshot().activeTabId === store.getSnapshot().tabs[0].id);

const [t1, t2, t3] = store.getSnapshot().tabs;
actions.move(t3.id, t1.id, false);
check('move 到目标之前', store.getSnapshot().tabs.map((tab) => tab.sessionId).join(',') === 's3,s1,s2');
actions.move(t3.id, t1.id, true);
check('move 到目标之后', store.getSnapshot().tabs.map((tab) => tab.sessionId).join(',') === 's1,s3,s2');

const beforeReassign = store.getSnapshot().tabs;
actions.reassign(beforeReassign[1].id, 's2');
check('reassign 撞到已存在的会话时合并掉该标签', store.getSnapshot().tabs.length === 2
  && store.getSnapshot().tabs.map((tab) => tab.sessionId).join(',') === 's1,s2');

actions.select(store.getSnapshot().tabs[1].id);
actions.close(store.getSnapshot().tabs[1].id);
check('close 移除标签并清空选中', store.getSnapshot().tabs.length === 1 && store.getSnapshot().activeTabId === null);

actions.open('s9');
actions.open('s8');
actions.closeMany(store.getSnapshot().tabs.map((tab) => tab.id));
check('closeMany 清空全部', store.getSnapshot().tabs.length === 0);

/* ------------------------------------------------------------ 4. 服务门面 */

console.log('4) projectTabs 服务门面');
const service = provided.find((item) => item.name === 'projectTabs')?.value;
const sessionId = await service.openWorkspaceInTab('ws-42');
check('openWorkspaceInTab 连接了工作区', connected.at(-1) === 'ws-42');
check('openWorkspaceInTab 打开了会话', opened.at(-1) === sessionId);
check('openWorkspaceInTab 建了标签', service.listTabs().some((tab) => tab.sessionId === sessionId));
check('window 兜底指向同一个门面', globalThis.__DSH_PROJECT_TABS__ === service);

/* ------------------------------------------------------------ 5. 组件渲染 */

console.log('5) 组件渲染');
actions.open('s1');
actions.open('s2');
const seeded = store.getSnapshot();
const activeId = seeded.tabs[1].id;
actions.select(activeId);

const sessionRows = {
  s1: { id: 's1', title: '分析日志', blank: false, cwd: 'H:\\work\\alpha', retainedBy: {} },
  s2: { id: 's2', title: '', blank: false, cwd: 'H:\\work\\beta', retainedBy: { mainView: 1 } },
  s3: { id: 's3', title: '别的', blank: false, cwd: 'H:\\work\\gamma', retainedBy: {} },
};
const workspaceRows = [
  { workspaceId: 'w1', path: 'H:\\work\\alpha', title: 'alpha', sessionIds: ['s1'] },
  { workspaceId: 'w2', path: 'H:\\work\\beta', title: 'beta', sessionIds: ['s2'] },
  { workspaceId: 'w3', path: 'H:\\work\\gamma', title: 'gamma', sessionIds: ['s3'] },
];
const statusRows = new Map([
  ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s2', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
  ['s3', { running: false, pendingInteraction: undefined, completionUnread: true }],
]);

const props = {
  t: (key) => key,
  tabsStore: store,
  openSession: (id) => opened.push(id),
  connectWorkspace: ctx.uiWorkspace.connectWorkspace,
  createWorkspace: ctx.workspaces.create,
  pickDirectory: ctx.uiWorkspace.pickDirectory,
  retainSession: ctx.sessions.retain,
  useSessions: (pick) => pick({ phase: 'ready', ids: ['s1', 's2', 's3'], byId: sessionRows }),
  useWorkspaces: (pick) => pick({ items: workspaceRows }),
  useSessionStatus: (pick) => pick(statusRows),
};

mini.reset();
let tree = null;
let renderThrew = null;
try {
  tree = renderRoot(registration.component, props);
} catch (error) {
  renderThrew = error;
}
check('组件渲染不抛异常', renderThrew === null, renderThrew?.stack?.split('\n').slice(0, 2).join(' | '));

const tabs = findAll(tree, (node) => node.type === 'div' && node.props.className === 'dpt-tab');
check('渲染出的标签数量与 store 一致', tabs.length === seeded.tabs.length, `得到 ${tabs.length}`);
check('标签栏有 tablist', findAll(tree, (node) => node.props.role === 'tablist').length === 1);
check('有“新建标签”按钮', findAll(tree, (node) => node.props.className === 'dpt-add').length === 1);

const activeTabs = tabs.filter((node) => node.props['data-active'] === '');
check('只有一个标签处于选中态', activeTabs.length === 1);
check('选中态落在正确的标签上', activeTabs[0]?.props['data-tab-id'] === activeId);

const labels = tabs.map((node) => textOf(node.props.children));
check('项目名来自工作区目录', labels.some((text) => text.includes('alpha')) && labels.some((text) => text.includes('beta')),
  labels.join(' / '));
check('标签只显示工作区标题、不显示会话标题', !labels.some((text) => text.includes('分析日志')), labels.join(' / '));

/* 「+」必须紧跟在最后一个标签后面（不是钉在栏尾） */
const strip = findAll(tree, (node) => node.props.role === 'tablist')[0];
const stripChildren = (Array.isArray(strip.props.children) ? strip.props.children : []).flat();
check('「+」是那一条里的最后一个子元素',
  stripChildren.length === tabs.length + 1
  && stripChildren[stripChildren.length - 1]?.props?.items?.some((item) => item.id === 'pick'),
  `子元素 ${stripChildren.length} 个 / 标签 ${tabs.length} 个`);
check('标签本身带 data-state 供状态着色', tabs.every((node) => typeof node.props['data-state'] === 'string'));

const dots = findAll(tree, (node) => node.type === 'StateDot');
check('运行中的会话显示 ongoing', dots.some((node) => node.props.state === 'ongoing'));
check('等待审批的会话显示 warning', dots.some((node) => node.props.state === 'warning'));
check('没有状态时显示 idle', dots.some((node) => node.props.state === 'idle'));

/* 点标签 -> openSession(该标签的会话) */
const betaTab = tabs.find((node) => textOf(node.props.children).includes('beta'));
const beforeOpen = opened.length;
betaTab.props.onClick({ preventDefault() {}, stopPropagation() {} });
check('点标签切换到它绑定的会话', opened.length === beforeOpen + 1 && opened.at(-1) === 's2');

/* 点关闭 -> store 少一个标签，且不动会话 */
const closeButton = findAll(betaTab, (node) => node.props.className === 'dpt-close')[0];
const beforeClose = store.getSnapshot().tabs.length;
closeButton.props.onClick({ preventDefault() {}, stopPropagation() {} });
check('关闭按钮移除对应标签', store.getSnapshot().tabs.length === beforeClose - 1);

/* 右键 -> 弹上下文菜单（第二次渲染复用同一份 hook 状态，像 React 重渲染那样） */
const firstTab = tabs[0];
firstTab.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 30 });
const menuTree = renderRoot(registration.component, props);
const contextMenus = findAll(menuTree, (node) => node.type === 'Menu' && node.props.getAnchorRect !== undefined);
check('右键后出现上下文菜单', contextMenus.length === 1 && contextMenus[0].props.open === true);
check('上下文菜单有关闭项', contextMenus[0].props.items.some((item) => item.id === 'close'));

/* ------------------------------------------------------------ 6. 副作用 */

console.log('6) 副作用：几何 / 跟随 / 保活 / 清理');

/* domino 的元素没有布局，这里补一个零矩形，再按需要覆盖。 */
const elementProto = Object.getPrototypeOf(doc.createElement('div'));
if (typeof elementProto.getBoundingClientRect !== 'function') {
  elementProto.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
}

/* 造一个最小 AppFrame：sidebar | center(main) | overlay */
doc.body.innerHTML = '';
const frame = doc.createElement('div');
const centerColumn = doc.createElement('div');
const mainSlot = doc.createElement('div');
mainSlot.setAttribute('data-slot', 'main');
centerColumn.appendChild(mainSlot);
const overlayLayer = doc.createElement('div');
overlayLayer.setAttribute('data-shell-overlay', '');
frame.appendChild(doc.createElement('div'));
frame.appendChild(centerColumn);
frame.appendChild(overlayLayer);
doc.body.appendChild(frame);
const nativeMenu = doc.createElement('div');
nativeMenu.setAttribute('data-windows-menu', '');
doc.body.appendChild(nativeMenu);

const geometryOf = () => mini.stack[0].slots[0];

/* --- 6a. Windows 标题栏模式：直接落在 40px 带子里，不动布局 --- */
doc.documentElement.setAttribute('data-windows-titlebar', '');
actions.closeMany(store.getSnapshot().tabs.map((tab) => tab.id));
actions.open('s1');
renderRoot(registration.component, props);
let cleanup = flushEffects();
const titlebarGeometry = geometryOf();
check('标题栏模式被识别', titlebarGeometry?.mode === 'titlebar', JSON.stringify(titlebarGeometry));
check('高度取 --dsh-windows-titlebar-height 的兜底 40', titlebarGeometry?.height === 40);
check('避开原生菜单（left > 48）', (titlebarGeometry?.left ?? 0) > 48, String(titlebarGeometry?.left));
check('给窗口按钮留了位置（宽度 < 窗口宽）', (titlebarGeometry?.width ?? 0) > 0 && (titlebarGeometry?.width ?? 0) < win.innerWidth);
check('标题栏模式不动中栏内边距', centerColumn.style.paddingTop !== '36px');
cleanup();

/* --- 6b. 非标题栏（浏览器 / macOS）：贴中栏顶部并把内容推下去 --- */
doc.documentElement.removeAttribute('data-windows-titlebar');
renderRoot(registration.component, props);
cleanup = flushEffects();
const columnGeometry = geometryOf();
check('降级为 column 模式', columnGeometry?.mode === 'column', JSON.stringify(columnGeometry));
check('中栏被让出 36px', centerColumn.style.paddingTop === '36px');
cleanup();
check('卸载后撤销中栏内边距', centerColumn.style.paddingTop === '');

/* --- 6c. 后台标签全部被 retain 保活（不只是在跑的） --- */
doc.documentElement.setAttribute('data-windows-titlebar', '');
const sessions = (rows) => (pick) => pick({ phase: 'ready', ids: Object.keys(rows), byId: rows });
const statusMap = (rows) => (pick) => pick(new Map(Object.entries(rows)));

actions.closeMany(store.getSnapshot().tabs.map((tab) => tab.id));
actions.open('s1');   /* 后台、在跑 */
actions.open('s2');   /* 前台（mainView） */
actions.open('s3');   /* 后台、空闲 */
retained.length = 0;
renderRoot(registration.component, {
  ...props,
  useSessions: sessions({
    s1: { id: 's1', blank: false, cwd: 'H:\\a', retainedBy: {} },
    s2: { id: 's2', blank: false, cwd: 'H:\\b', retainedBy: { mainView: 1 } },
    s3: { id: 's3', blank: false, cwd: 'H:\\c', retainedBy: {} },
  }),
  useSessionStatus: statusMap({ s1: { running: true }, s2: { running: true }, s3: { running: false } }),
});
cleanup = flushEffects();
check('后台在跑的标签被 retain（在跑的优先）', retained[0] === 's1', retained.join(','));
check('后台空闲的标签同样被 retain（切过去就是热的）', retained.includes('s3'), retained.join(','));
check('前台标签不重复 retain（mainView 自己持有）', !retained.includes('s2'), retained.join(','));
cleanup();

/* --- 6d. 侧边栏切到没标签的会话：当前标签接管它 --- */
actions.closeMany(store.getSnapshot().tabs.map((tab) => tab.id));
actions.open('s1');
renderRoot(registration.component, {
  ...props,
  useSessions: sessions({
    s1: { id: 's1', blank: false, cwd: 'H:\\a', retainedBy: {} },
    s3: { id: 's3', blank: false, cwd: 'H:\\c', retainedBy: { mainView: 1 } },
  }),
  useSessionStatus: statusMap({}),
});
cleanup = flushEffects();
check('当前标签接管了侧边栏切过来的会话',
  store.getSnapshot().tabs.length === 1 && store.getSnapshot().tabs[0].sessionId === 's3',
  JSON.stringify(store.getSnapshot().tabs));
cleanup();

/* --- 6e. 会话消失（归档/删除）时标签被摘掉 --- */
actions.open('ghost');
renderRoot(registration.component, {
  ...props,
  useSessions: sessions({
    s3: { id: 's3', blank: false, cwd: 'H:\\c', retainedBy: { mainView: 1 } },
  }),
  useSessionStatus: statusMap({}),
});
cleanup = flushEffects();
check('已消失的会话标签被清理',
  !store.getSnapshot().tabs.some((tab) => tab.sessionId === 'ghost'),
  JSON.stringify(store.getSnapshot().tabs));
cleanup();

/* ------------------------------------------------------------ 收尾 */

console.log('');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}

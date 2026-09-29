/**
 * dsh-project-tabs — 客户端半边：窗口顶部（Windows 原生标题栏那条）的项目标签栏。
 *
 * 效果：标题栏里原生「应用/编辑」菜单右侧的空白区变成一排浏览器式标签；
 * 一个标签死绑一条会话，点一下就切过去；标签上带状态点：
 *   转圈 = 运行中 / 黄点 = 等待审批 / 对勾 = 已跑完未读 / 灰点 = 空闲。
 *
 * 为什么这么写（都是被 0.2.0 的实现逼出来的，改动前请先读）：
 *
 * 1. **挂载点**：`shell.overlay` 是唯一一个「root 作用域 + list + replaceRisk:none」的
 *    全窗口浮层插槽（dsh-client-ui-layout 声明，`.BynINW_overlayLayer{position:absolute;
 *    inset:0;z-index:20;pointer-events:none}`，子元素自行 `pointer-events:auto`）。
 *    Windows 下 frame 有 `padding-top: var(--dsh-windows-titlebar-height)`（40px），
 *    绝对定位的包含块是 padding box，所以 `top:0` 正好落在标题栏那条 40px 里。
 *
 * 2. **不要抢原生菜单和窗口按钮的地盘**：桌面 preload 用 shadow DOM 在
 *    `[data-windows-menu]{position:fixed;top:0;left:var(--dsh-windows-menu-start,48px)}` 画了
 *    「应用/编辑」；右上角是 Electron `titleBarOverlay` 自绘的最小化/最大化/关闭。
 *    前者运行时量它的 rect，后者用 `env(titlebar-area-*)` 探针量（Electron 的
 *    `titleBarOverlay` 会暴露 Window Controls Overlay 的那组 env 变量）。
 *
 * 3. **切换标签 = `ctx.uiWorkspace.openSession(sessionId)`**：0.2.0 里「当前显示的会话」
 *    就是 `retainedBy.mainView > 0` 的那一条，openSession 同步换掉这个引用。
 *    滚动位置不用我们管：`dsh-client-ui-chat` 自己有一份 per-session 的语义锚点记忆
 *    （`chatScrollPositions`，值是 `{anchorKey, anchorTop, scrollTop}`），切回来自动还原。
 *
 * 4. **后台跑着的标签要自己保活**：mainView 只保留一条会话，被切走的会话会关掉本地
 *    事件流。所以对「不在前台但在跑」的标签额外持一个 `sessions.retain(source:'projectTabs')`，
 *    这样切回去是热的历史窗口 + 活的 tail。不跑的标签不占资源，切过去现开。
 *
 * 5. **不依赖任何构建**：bundle 是 classic script，只调用 `window.__ModuleLoader__.load`。
 *    `require()` 能用平台静态模块表里的东西：react、react/jsx-runtime、react-dom/client、
 *    @deepseek-ai/dsh-client-store、-ui-slots、-ui-primitives、-ui-dockkit。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-tabs',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { defineStore } = require('@deepseek-ai/dsh-client-store');

    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const {
      Menu,
      StateDot,
      IconPlusOutlineRegular,
      IconCloseFillRegular,
      IconFolderCloseRegular,
    } = primitives;

    /* ------------------------------------------------------------------ 常量 */

    const NS = 'project-tabs';
    const STYLE_ID = 'dsh-project-tabs/bar.css';
    const PERSIST_KEY = 'dsh.project.tabs.v1';
    /** 没有 data-windows-titlebar 时（普通浏览器 / macOS）标签栏的高度。 */
    const COLUMN_BAR_HEIGHT = 36;
    /** 量不到 --dsh-windows-titlebar-height 时的兜底（桌面端实际写的是 40px）。 */
    const TITLEBAR_FALLBACK_HEIGHT = 40;
    /** 量不到 env(titlebar-area-*) 时给窗口按钮留的兜底宽度。 */
    const CAPTION_FALLBACK_WIDTH = 138;
    /** 找不到 [data-windows-menu] 时，原生菜单之后留出的兜底宽度。 */
    const MENU_FALLBACK_WIDTH = 116;
    /**
     * 最多同时保活多少个后台标签。每个保活的标签 = 一条
     * `remote.session.follow` 实时流 + 一份已加载的历史窗口，
     * 所以给个上限；在跑的标签永远优先保留。
     */
    const MAX_WARM_TABS = 10;

    const DICT = {
      zh: {
        'tabs.new': '新建标签',
        'tabs.close': '关闭标签',
        'tabs.closeOthers': '关闭其他标签',
        'tabs.closeRight': '关闭右侧标签',
        'tabs.copyPath': '复制项目路径',
        'tabs.group.open': '在新标签中打开项目',
        'tabs.group.pick': '或者',
        'tabs.pick': '选择目录…',
        'tabs.noWorkspace': '还没有工作区',
        'tabs.status.running': '运行中',
        'tabs.status.approval': '等待审批',
        'tabs.status.done': '已跑完（未读）',
        'tabs.status.idle': '空闲',
        'tabs.untitled': '未命名会话',
        'tabs.copyOk': '已复制：{path}',
        'tabs.copyFail': '复制失败',
      },
      en: {
        'tabs.new': 'New tab',
        'tabs.close': 'Close tab',
        'tabs.closeOthers': 'Close other tabs',
        'tabs.closeRight': 'Close tabs to the right',
        'tabs.copyPath': 'Copy project path',
        'tabs.group.open': 'Open a project in a new tab',
        'tabs.group.pick': 'or',
        'tabs.pick': 'Choose a folder…',
        'tabs.noWorkspace': 'No workspace yet',
        'tabs.status.running': 'Running',
        'tabs.status.approval': 'Waiting for approval',
        'tabs.status.done': 'Finished (unread)',
        'tabs.status.idle': 'Idle',
        'tabs.untitled': 'Untitled session',
        'tabs.copyOk': 'Copied: {path}',
        'tabs.copyFail': 'Copy failed',
      },
    };

    /** 标签栏自身的样式。用 :hover / [data-*] 的状态选择器，内联样式做不到。
     *  颜色只用 Theme 服务确实提供的 token（brand / label / border-l1..l2 /
     *  state-warn|success|idle），深浅色主题都被覆盖。 */
    const CSS = `
[data-project-tabs] {
  -webkit-app-region: drag;
  pointer-events: auto;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 8px;
  z-index: 30;
}
[data-project-tabs] .dpt-strip {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
[data-project-tabs] .dpt-strip::-webkit-scrollbar { display: none; }
[data-project-tabs] .dpt-tab {
  -webkit-app-region: no-drag;
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  max-width: 220px;
  height: 28px;
  padding: 0 6px 0 10px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  text-align: left;
  cursor: default;
  user-select: none;
  overflow: hidden;
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l1);
  transition: background-color .12s ease, color .12s ease;
}
[data-project-tabs] .dpt-tab:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 17%, transparent);
  color: var(--dsw-alias-label-primary);
}
/* 当前标签：品牌色底 + 亮描边，在标题栏上很显眼 */
[data-project-tabs] .dpt-tab[data-active] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 68%, transparent);
}
/* 跑完未读：绿底 + 加粗，一眼就能看见「B 干完了」 */
[data-project-tabs] .dpt-tab[data-state="done"] {
  color: var(--dsw-alias-label-primary);
  font-weight: 650;
}
[data-project-tabs] .dpt-tab[data-state="done"]:not([data-active]) {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-success-primary) 58%, transparent);
}
/* 等审批：黄底，最该被注意到的那种 */
[data-project-tabs] .dpt-tab[data-state="warning"] {
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, transparent);
}
[data-project-tabs] .dpt-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
[data-project-tabs] .dpt-close {
  -webkit-app-region: no-drag;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: default;
  transition: opacity .12s ease, background-color .12s ease;
}
[data-project-tabs] .dpt-tab:hover .dpt-close,
[data-project-tabs] .dpt-tab[data-active] .dpt-close { opacity: .55; }
[data-project-tabs] .dpt-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
/* 「+」跟在最后一个标签后面 */
[data-project-tabs] .dpt-add {
  -webkit-app-region: no-drag;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  color: var(--dsw-alias-label-secondary);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l1);
  cursor: default;
  transition: background-color .12s ease, color .12s ease;
}
[data-project-tabs] .dpt-add:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent);
  color: var(--dsw-alias-label-primary);
}
[data-project-tabs] .dpt-drop {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-brand-primary);
}
`;

    /* -------------------------------------------------------------- 小工具 */

    let tabSeq = 0;
    /** 给标签一个本地唯一 id（只用于前端排序 / 定位，不是会话 id）。 */
    function nextTabId() {
      tabSeq += 1;
      return `t${Date.now().toString(36)}${tabSeq.toString(36)}`;
    }

    /** 取路径最后一段（同时认 Windows 反斜杠和 POSIX 斜杠）。 */
    function baseName(value) {
      const text = String(value ?? '').replace(/[\\/]+$/, '');
      const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
      return at < 0 ? text : text.slice(at + 1);
    }

    /** 桌面端会把 `--dsh-windows-titlebar-height` 写成 40px（preload-app.cjs）。 */
    function readTitlebarHeight() {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height');
      const px = Number.parseFloat(raw);
      return Number.isFinite(px) && px > 0 ? px : TITLEBAR_FALLBACK_HEIGHT;
    }

    /** 原生「应用/编辑」菜单右边缘：运行时量，菜单文字随语言变宽也跟得上。 */
    function readMenuRight() {
      const menu = document.querySelector('[data-windows-menu]');
      if (menu !== null) {
        const rect = menu.getBoundingClientRect();
        if (rect.width > 0) return rect.right;
      }
      const start = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start'),
      );
      const left = Number.isFinite(start) && start > 0 ? start : 48;
      return left + MENU_FALLBACK_WIDTH;
    }

    /** 窗口按钮占掉的宽度：用 Window Controls Overlay 的 env 变量探针量。 */
    let captionProbe = null;
    function readCaptionReserve() {
      if (captionProbe === null || !captionProbe.isConnected) {
        captionProbe = document.createElement('div');
        captionProbe.setAttribute('aria-hidden', 'true');
        captionProbe.style.cssText = 'position:fixed;top:0;left:0;height:1px;visibility:hidden;pointer-events:none';
        document.body.appendChild(captionProbe);
      }
      captionProbe.style.width = 'env(titlebar-area-width, 0px)';
      captionProbe.style.left = 'env(titlebar-area-x, 0px)';
      const rect = captionProbe.getBoundingClientRect();
      if (!(rect.width > 0)) return CAPTION_FALLBACK_WIDTH;
      return Math.max(8, Math.round(window.innerWidth - (rect.left + rect.width)));
    }

    /** shell.overlay 所在的浮层 → 它的父节点就是三栏 AppFrame。 */
    function frameElement() {
      const overlay = document.querySelector('[data-shell-overlay]');
      return overlay === null ? null : overlay.parentElement;
    }

    /** frame 里包着 [data-slot="main"] 的那一栏，也就是中栏（不依赖哈希类名）。 */
    function centerColumnElement(frame) {
      if (frame === null) return null;
      const main = document.querySelector('[data-slot="main"]');
      if (main === null) return null;
      let node = main;
      while (node.parentElement !== null && node.parentElement !== frame) node = node.parentElement;
      return node.parentElement === frame ? node : null;
    }

    function sameGeometry(left, right) {
      return left !== null
        && left.mode === right.mode
        && left.top === right.top
        && left.left === right.left
        && left.width === right.width
        && left.height === right.height;
    }

    /**
     * 维护标签栏几何。两种模式：
     *  - `titlebar`：Windows 桌面。frame 已经用 padding-top 让出了 40px，直接落在里面，不动布局。
     *  - `column`：普通浏览器 / macOS。贴在中栏顶部，并给中栏加 padding-top 把内容推下去。
     * @returns `{ mode, top, left, width, height }`，还没量到时为 null。
     */
    function useTabBarGeometry() {
      const [geometry, setGeometry] = useState(null);

      useLayoutEffect(() => {
        let disposed = false;
        let raf = null;
        let paddedColumn = null;
        let menuObserver = null;
        let menuElement = null;

        const schedule = () => {
          if (disposed || raf !== null) return;
          raf = requestAnimationFrame(() => {
            raf = null;
            measure();
          });
        };

        const observeMenu = () => {
          const menu = document.querySelector('[data-windows-menu]');
          if (menu === menuElement) return;
          menuObserver?.disconnect();
          menuObserver = null;
          menuElement = menu;
          if (menu !== null && typeof ResizeObserver === 'function') {
            menuObserver = new ResizeObserver(schedule);
            menuObserver.observe(menu);
          }
          schedule();
        };

        const measure = () => {
          if (disposed) return;
          const titlebar = document.documentElement.hasAttribute('data-windows-titlebar');

          if (titlebar) {
            if (paddedColumn !== null) {
              paddedColumn.style.removeProperty('padding-top');
              paddedColumn = null;
            }
            const height = readTitlebarHeight();
            const left = Math.round(readMenuRight() + 8);
            const right = readCaptionReserve();
            const width = Math.max(0, window.innerWidth - left - right);
            const next = { mode: 'titlebar', top: 0, left, width, height };
            setGeometry((current) => (sameGeometry(current, next) ? current : next));
            return;
          }

          const column = centerColumnElement(frameElement());
          if (column === null) return;
          if (paddedColumn !== column) {
            paddedColumn?.style.removeProperty('padding-top');
            paddedColumn = column;
          }
          column.style.paddingTop = `${COLUMN_BAR_HEIGHT}px`;
          const rect = column.getBoundingClientRect();
          const next = {
            mode: 'column',
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.max(0, Math.round(rect.width)),
            height: COLUMN_BAR_HEIGHT,
          };
          setGeometry((current) => (sameGeometry(current, next) ? current : next));
        };

        /* 首次测量 + 把可能迟到的原生菜单逮住 */
        measure();
        observeMenu();

        const timers = [
          window.setTimeout(() => { observeMenu(); measure(); }, 300),
          window.setTimeout(() => { observeMenu(); measure(); }, 1500),
        ];

        /* 三栏宽度变化（侧栏收起 / 右侧面板开关）→ 中栏几何变化 */
        let frameObserver = null;
        const attachFrame = () => {
          const frame = frameElement();
          if (frame === null || typeof ResizeObserver !== 'function') return;
          frameObserver?.disconnect();
          frameObserver = new ResizeObserver(schedule);
          frameObserver.observe(frame);
        };
        attachFrame();

        const bodyObserver = new MutationObserver(() => {
          observeMenu();
          attachFrame();
        });
        bodyObserver.observe(document.body, { childList: true, subtree: false });

        window.addEventListener('resize', schedule);
        if (document.fonts !== undefined && typeof document.fonts.ready?.then === 'function') {
          document.fonts.ready.then(schedule).catch(() => {});
        }

        return () => {
          disposed = true;
          if (raf !== null) cancelAnimationFrame(raf);
          for (const timer of timers) window.clearTimeout(timer);
          window.removeEventListener('resize', schedule);
          menuObserver?.disconnect();
          frameObserver?.disconnect();
          bodyObserver.disconnect();
          paddedColumn?.style.removeProperty('padding-top');
        };
      }, []);

      return geometry;
    }

    /* ------------------------------------------------------------ 会话映射 */

    /** 一条会话属于哪个项目：先在工作区里找，退化到 session.cwd。 */
    function projectOf(sessionId, session, workspaces) {
      const workspace = workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
      const path = workspace?.path ?? session?.cwd ?? '';
      const storedTitle = typeof workspace?.title === 'string' ? workspace.title.trim() : '';
      const title = storedTitle !== '' && storedTitle !== 'default-workspace' ? storedTitle : '';
      const label = title !== '' ? title : baseName(path);
      return { path: String(path ?? ''), label };
    }

    function sessionTitleOf(session) {
      if (session === undefined || session.blank === true) return '';
      const title = typeof session.title === 'string' ? session.title.trim() : '';
      return title;
    }

    /** 标签上的状态点：等待审批 > 运行中 > 已跑完未读 > 空闲。 */
    function statusOf(status) {
      if (status === undefined) return 'idle';
      if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'warning';
      if (status.running === true) return 'ongoing';
      if (status.completionUnread === true) return 'done';
      return 'idle';
    }

    const STATUS_KEY = {
      warning: 'tabs.status.approval',
      ongoing: 'tabs.status.running',
      done: 'tabs.status.done',
      idle: 'tabs.status.idle',
    };

    /* ------------------------------------------------------------- 标签按钮 */

    function ProjectTab(props) {
      const {
        tab, sessionId, label, tooltip, state, active, t,
        onActivate, onClose, onContextMenu, onDragStart, onDragOver, onDrop, onDragEnd,
        dropSide,
      } = props;

      return jsx('div', {
        className: 'dpt-tab',
        role: 'tab',
        tabIndex: -1,
        title: tooltip,
        'aria-selected': active === true,
        'data-active': active === true ? '' : undefined,
        'data-state': state,
        'data-tab-id': tab.id,
        draggable: true,
        onClick: (event) => {
          event.preventDefault();
          onActivate(tab.id, sessionId);
        },
        onAuxClick: (event) => {
          /* 中键关闭，跟浏览器一致 */
          if (event.button === 1) {
            event.preventDefault();
            onClose(tab.id, sessionId);
          }
        },
        onContextMenu: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(tab.id, event.clientX, event.clientY);
        },
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', tab.id);
          onDragStart(tab.id);
        },
        onDragOver: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const box = event.currentTarget.getBoundingClientRect();
          onDragOver(tab.id, event.clientX < box.left + box.width / 2 ? 'before' : 'after');
        },
        onDrop: (event) => {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          onDrop(tab.id, event.clientX < box.left + box.width / 2 ? 'before' : 'after');
        },
        onDragEnd,
        children: [
          jsx('span', {
            style: { display: 'flex', alignItems: 'center', flex: '0 0 auto' },
            children: jsx(StateDot, { state, size: state === 'ongoing' ? 14 : 9 }),
          }),
          jsx('span', { className: 'dpt-label', children: label }),
          jsx('button', {
            type: 'button',
            className: 'dpt-close',
            'aria-label': t('tabs.close'),
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              onClose(tab.id, sessionId);
            },
            children: jsx(IconCloseFillRegular, { size: 10 }),
          }),
          dropSide === null ? null : jsx('span', {
            className: 'dpt-drop',
            style: dropSide === 'before' ? { left: -3 } : { right: -3 },
          }),
        ],
      });
    }

    /* ------------------------------------------------------------- 新建标签 */

    function NewTabMenu({ t, items, onSelect }) {
      const [open, setOpen] = useState(false);
      const anchor = jsx('button', {
        type: 'button',
        className: 'dpt-add',
        'aria-label': t('tabs.new'),
        title: t('tabs.new'),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
        children: jsx(IconPlusOutlineRegular, { size: 14 }),
      });
      return jsx(Menu, {
        open,
        anchor,
        items,
        align: 'start',
        side: 'bottom',
        portal: true,
        autoFocus: true,
        onSelect: (id) => {
          setOpen(false);
          onSelect(id);
        },
        onClose: () => setOpen(false),
      });
    }

    /* ------------------------------------------------------------------ 主体 */

    function ProjectTabsBar(props) {
      const {
        t,
        tabsStore,
        openSession,
        connectWorkspace,
        createWorkspace,
        pickDirectory,
        retainSession,
        useSessions,
        useWorkspaces,
        useSessionStatus,
      } = props;

      const geometry = useTabBarGeometry();
      const stripRef = useRef(null);
      const dragRef = useRef(null);

      /* --- 标签状态：插件自己的 store（跨重启持久化） --- */
      const snapshot = useSyncExternalStore(tabsStore.subscribe, tabsStore.getSnapshot, tabsStore.getSnapshot);
      const actions = tabsStore.actions;
      const tabs = useMemo(
        () => (Array.isArray(snapshot.tabs) ? snapshot.tabs.filter((tab) => (
          tab !== null && typeof tab === 'object' && typeof tab.id === 'string' && typeof tab.sessionId === 'string'
        )) : []),
        [snapshot],
      );
      const activeTabId = tabs.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : null;

      /* --- 平台状态：谁在前台、会话清单、工作区、每条会话的运行状态 --- */
      const sessionIdsKey = useSessions((state) => (state.phase === 'ready' ? state.ids.join('\u0000') : ''));
      const sessionsById = useSessions((state) => state.byId);
      const workspaces = useWorkspaces((state) => (Array.isArray(state.items) ? state.items : []));
      const activeSessionId = useSessions((state) => {
        for (const id of state.ids) {
          const row = state.byId[id];
          if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id;
        }
        return undefined;
      });
      const statuses = useSessionStatus((map) => map);

      /* --- 跟随平台：前台会话变了就把它对到某个标签上 --- */
      const lastActiveRef = useRef(undefined);
      useEffect(() => {
        if (activeSessionId === lastActiveRef.current) return;
        lastActiveRef.current = activeSessionId;
        if (activeSessionId === undefined) return;
        const current = tabsStore.getSnapshot();
        const listed = Array.isArray(current.tabs) ? current.tabs : [];
        const hit = listed.find((tab) => tab.sessionId === activeSessionId);
        if (hit !== undefined) {
          if (current.activeTabId !== hit.id) actions.select(hit.id);
          return;
        }
        /* 侧边栏点了别的会话：优先复用当前标签，没有当前标签才新开一个 */
        if (current.activeTabId !== null && listed.some((tab) => tab.id === current.activeTabId)) {
          actions.reassign(current.activeTabId, activeSessionId);
          return;
        }
        actions.open(activeSessionId);
      }, [activeSessionId, tabsStore, actions]);

      /* --- 会话没了（归档/删除）就把对应标签摘掉 --- */
      useEffect(() => {
        if (sessionIdsKey === '') return;
        const alive = new Set(sessionIdsKey.split('\u0000'));
        const current = tabsStore.getSnapshot();
        const listed = Array.isArray(current.tabs) ? current.tabs : [];
        const dead = listed.filter((tab) => !alive.has(tab.sessionId)).map((tab) => tab.id);
        if (dead.length > 0) actions.closeMany(dead);
      }, [sessionIdsKey, tabsStore, actions]);

      /* --- 保活：每个后台标签都额外持一个 retain ---
         为什么不 retain 就「像每次都在重新加载」：mainView 只保留一条会话，切走的会话
         会 release 掉本地 generation，它的 SessionBinding / 已加载历史窗口 / 实时 tail
         全部销毁。再切回去时是**冷开**（openState: 'loading'），看起来就是在重新加载。
         持一个 source:'projectTabs' 的引用之后，历史窗口和 tail 一直活着，
         切回去 ConversationMainPanel 直接是 active 相位 —— 不闪、不等。
         代价是每个标签一条事件流，所以只保前 MAX_WARM_TABS 个（在跑的优先）。 */
      const keepWarmKey = useMemo(() => {
        const running = [];
        const idle = [];
        for (const tab of tabs) {
          if (tab.sessionId === activeSessionId) continue;          /* mainView 自己已经 retain 了 */
          if (sessionsById[tab.sessionId] === undefined) continue;  /* 还没进清单 / 已经消失：别去 retain 未知 id */
          (statuses.get(tab.sessionId)?.running === true ? running : idle).push(tab.sessionId);
        }
        return [...running, ...idle].slice(0, MAX_WARM_TABS).join('\u0000');
      }, [tabs, statuses, sessionsById, activeSessionId]);

      const retainedRef = useRef(null);
      if (retainedRef.current === null) retainedRef.current = new Map();
      useEffect(() => {
        const held = retainedRef.current;
        const wanted = new Set(keepWarmKey === '' ? [] : keepWarmKey.split('\u0000'));
        for (const [sessionId, reference] of [...held]) {
          if (wanted.has(sessionId)) continue;
          held.delete(sessionId);
          try { reference.release(); } catch { /* 释放失败不影响界面 */ }
        }
        for (const sessionId of wanted) {
          if (held.has(sessionId)) continue;
          try { held.set(sessionId, retainSession(sessionId)); } catch { /* 拿不到就不保活 */ }
        }
      }, [keepWarmKey, retainSession]);
      useEffect(() => () => {
        const held = retainedRef.current;
        if (held === null) return;
        for (const reference of held.values()) {
          try { reference.release(); } catch { /* 忽略 */ }
        }
        held.clear();
      }, []);

      /* --- 当前标签滚进可见范围 --- */
      useEffect(() => {
        const strip = stripRef.current;
        if (strip === null || activeTabId === null) return;
        const element = strip.querySelector('[data-active]');
        if (element === null) return;
        const left = element.offsetLeft;
        const right = left + element.offsetWidth;
        if (left - 8 < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
        else if (right + 8 > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + 8 - strip.clientWidth;
      }, [activeTabId, tabs.length]);

      /* --- 交互 --- */
      const activate = useCallback((tabId, sessionId) => {
        actions.select(tabId);
        openSession(sessionId);
      }, [actions, openSession]);

      const closeTab = useCallback((tabId, sessionId) => {
        const current = tabsStore.getSnapshot();
        const listed = Array.isArray(current.tabs) ? current.tabs : [];
        const index = listed.findIndex((tab) => tab.id === tabId);
        const wasActive = current.activeTabId === tabId || sessionId === lastActiveRef.current;
        const neighbour = listed[index + 1] ?? listed[index - 1];
        actions.close(tabId);
        if (!wasActive) return;
        if (neighbour === undefined) return;   /* 关掉最后一个标签：只关标签，不动会话 */
        actions.select(neighbour.id);
        openSession(neighbour.sessionId);
      }, [actions, tabsStore, openSession]);

      /* 右键菜单 */
      const [contextMenu, setContextMenu] = useState(null);
      const contextTab = contextMenu === null ? null : tabs.find((tab) => tab.id === contextMenu.tabId) ?? null;
      const contextSession = contextTab === null ? undefined : sessionsById[contextTab.sessionId];
      const contextProject = contextTab === null ? { path: '' } : projectOf(contextTab.sessionId, contextSession, workspaces);
      const contextItems = useMemo(() => {
        if (contextTab === null) return [];
        const listed = tabs;
        const index = listed.findIndex((tab) => tab.id === contextTab.id);
        const items = [{ id: 'close', label: t('tabs.close') }];
        if (listed.length > 1) items.push({ id: 'closeOthers', label: t('tabs.closeOthers') });
        if (index >= 0 && index < listed.length - 1) items.push({ id: 'closeRight', label: t('tabs.closeRight') });
        if (contextProject.path !== '') {
          items.push({ id: 'sep', type: 'separator' });
          items.push({ id: 'copyPath', label: t('tabs.copyPath') });
        }
        return items;
      }, [contextTab, tabs, contextProject.path, t]);

      const onContextSelect = useCallback((id) => {
        if (contextTab === null) return;
        const listed = tabsStore.getSnapshot().tabs ?? [];
        const index = listed.findIndex((tab) => tab.id === contextTab.id);
        if (id === 'close') closeTab(contextTab.id, contextTab.sessionId);
        else if (id === 'closeOthers') actions.closeMany(listed.filter((tab) => tab.id !== contextTab.id).map((tab) => tab.id));
        else if (id === 'closeRight') actions.closeMany(listed.slice(index + 1).map((tab) => tab.id));
        else if (id === 'copyPath' && contextProject.path !== '') {
          try { navigator.clipboard?.writeText(contextProject.path).catch(() => {}); } catch { /* 忽略 */ }
        }
        setContextMenu(null);
      }, [contextTab, tabsStore, actions, closeTab, contextProject.path]);

      /* 拖拽排序 */
      const [dropHint, setDropHint] = useState(null);
      const onDragStart = useCallback((tabId) => { dragRef.current = tabId; }, []);
      const onDragOver = useCallback((tabId, side) => {
        const dragged = dragRef.current;
        if (dragged === null || dragged === tabId) { setDropHint(null); return; }
        setDropHint({ tabId, side });
      }, []);
      const onDragEnd = useCallback(() => { dragRef.current = null; setDropHint(null); }, []);
      const onDrop = useCallback((tabId, side) => {
        const dragged = dragRef.current;
        dragRef.current = null;
        setDropHint(null);
        if (dragged === null || dragged === tabId) return;
        actions.move(dragged, tabId, side === 'after');
      }, [actions]);

      /* 新建标签菜单 */
      const addItems = useMemo(() => {
        const items = [{ id: 'lbl', type: 'label', text: t('tabs.group.open') }];
        if (workspaces.length === 0) {
          items.push({ id: 'none', type: 'label', text: t('tabs.noWorkspace') });
        } else {
          for (const workspace of workspaces) {
            const name = baseName(workspace.path) || workspace.title || workspace.workspaceId;
            items.push({
              id: `ws:${workspace.workspaceId}`,
              label: name,
              icon: jsx(IconFolderCloseRegular, { size: 14 }),
            });
          }
        }
        items.push({ id: 'sep', type: 'separator' });
        items.push({ id: 'lbl2', type: 'label', text: t('tabs.group.pick') });
        items.push({ id: 'pick', label: t('tabs.pick'), icon: jsx(IconPlusOutlineRegular, { size: 14 }) });
        return items;
      }, [workspaces, t]);

      const openInTab = useCallback(async (sessionId) => {
        actions.open(sessionId);
        openSession(sessionId);
      }, [actions, openSession]);

      const onAddSelect = useCallback((id) => {
        if (typeof id !== 'string') return;
        if (id.startsWith('ws:')) {
          const workspaceId = id.slice(3);
          connectWorkspace(workspaceId).then(openInTab, (reason) => {
            console.warn('[dsh-project-tabs] connectWorkspace failed:', reason);
          });
          return;
        }
        if (id !== 'pick') return;
        pickDirectory().then(async (path) => {
          if (path === null || path === undefined || path === '') return;
          const known = workspaces.find((workspace) => String(workspace.path).toLowerCase() === String(path).toLowerCase());
          const workspaceId = known !== undefined ? known.workspaceId : (await createWorkspace(path)).workspaceId;
          const sessionId = await connectWorkspace(workspaceId);
          await openInTab(sessionId);
        }).catch((reason) => {
          console.warn('[dsh-project-tabs] pick directory failed:', reason);
        });
      }, [workspaces, connectWorkspace, createWorkspace, pickDirectory, openInTab]);

      /* --- 渲染 --- */
      const style = geometry === null ? { display: 'none' } : {
        display: 'flex',
        position: 'fixed',
        top: `${geometry.top}px`,
        left: `${geometry.left}px`,
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
      };

      const strip = jsxs('div', {
        className: 'dpt-strip',
        role: 'tablist',
        ref: stripRef,
        onWheel: (event) => {
          if (event.ctrlKey || event.deltaY === 0) return;
          event.currentTarget.scrollLeft += event.deltaY;
        },
        children: [
          tabs.map((tab) => {
            const session = sessionsById[tab.sessionId];
            const project = projectOf(tab.sessionId, session, workspaces);
            const title = sessionTitleOf(session);
            /* 标签只显示工作区（项目）标题；没有工作区的孤儿会话才退回会话标题 */
            const label = project.label !== ''
              ? project.label
              : (title !== '' ? title : t('tabs.untitled'));
            const state = statusOf(statuses.get(tab.sessionId));
            const tooltip = [
              label,
              project.path !== '' ? project.path : '',
              title !== '' ? title : '',
              t(STATUS_KEY[state] ?? 'tabs.status.idle'),
            ].filter((line) => line !== '').join('\n');
            return jsx(ProjectTab, {
              tab,
              sessionId: tab.sessionId,
              label,
              tooltip,
              state,
              active: tab.id === activeTabId,
              t,
              onActivate: activate,
              onClose: closeTab,
              onContextMenu: (tabId, x, y) => setContextMenu({ tabId, x, y }),
              onDragStart,
              onDragOver,
              onDrop,
              onDragEnd,
              dropSide: dropHint !== null && dropHint.tabId === tab.id ? dropHint.side : null,
            }, tab.id);
          }),
          /* 「+」紧跟在最后一个标签后面 */
          jsx(NewTabMenu, { key: '__add', t, items: addItems, onSelect: onAddSelect }),
        ],
      });

      return jsxs(Fragment, {
        children: [
          jsx('div', { 'data-project-tabs': '', style, children: strip }),
          jsx(Menu, {
            open: contextMenu !== null,
            anchor: null,
            items: contextItems,
            portal: true,
            autoFocus: true,
            getAnchorRect: () => ({
              left: contextMenu === null ? 0 : contextMenu.x,
              right: contextMenu === null ? 0 : contextMenu.x,
              top: contextMenu === null ? 0 : contextMenu.y,
              bottom: contextMenu === null ? 0 : contextMenu.y,
              width: 0,
              height: 0,
            }),
            onSelect: onContextSelect,
            onClose: () => setContextMenu(null),
          }),
        ],
      });
    }

    /* -------------------------------------------------------------- 安装 */

    /** 标签集合的持久化 store（localStorage，origin 跨启动稳定）。 */
    function createTabStore() {
      return defineStore({
        init: () => ({ tabs: [], activeTabId: null }),
        persist: PERSIST_KEY,
        actions: {
          open: (draft, sessionId) => {
            const existing = draft.tabs.findIndex((tab) => tab.sessionId === sessionId);
            if (existing >= 0) {
              draft.activeTabId = draft.tabs[existing].id;
              return;
            }
            const id = nextTabId();
            draft.tabs.push({ id, sessionId });
            draft.activeTabId = id;
          },
          select: (draft, tabId) => {
            draft.activeTabId = tabId;
          },
          reassign: (draft, tabId, sessionId) => {
            const duplicate = draft.tabs.find((tab) => tab.id !== tabId && tab.sessionId === sessionId);
            if (duplicate !== undefined) {
              draft.tabs = draft.tabs.filter((tab) => tab.id !== tabId);
              draft.activeTabId = duplicate.id;
              return;
            }
            const tab = draft.tabs.find((item) => item.id === tabId);
            if (tab === undefined) return;
            tab.sessionId = sessionId;
            draft.activeTabId = tabId;
          },
          close: (draft, tabId) => {
            draft.tabs = draft.tabs.filter((tab) => tab.id !== tabId);
            if (draft.activeTabId === tabId) draft.activeTabId = null;
          },
          closeMany: (draft, tabIds) => {
            const drop = new Set(tabIds);
            if (drop.size === 0) return;
            draft.tabs = draft.tabs.filter((tab) => !drop.has(tab.id));
            if (draft.activeTabId !== null && drop.has(draft.activeTabId)) draft.activeTabId = null;
          },
          move: (draft, tabId, targetId, after) => {
            const from = draft.tabs.findIndex((tab) => tab.id === tabId);
            if (from < 0) return;
            const [moved] = draft.tabs.splice(from, 1);
            let to = draft.tabs.findIndex((tab) => tab.id === targetId);
            if (to < 0) {
              draft.tabs.splice(from, 0, moved);
              return;
            }
            if (after) to += 1;
            draft.tabs.splice(to, 0, moved);
          },
        },
      });
    }

    /** 装样式表；重复加载（HMR）时不会插第二份。 */
    function installStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-project-tabs';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * cordis 客户端插件入口。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      ctx.effect(() => ctx.locale.register(NS, DICT), 'project-tabs: dictionaries');
      ctx.effect(installStyle, 'project-tabs: stylesheet');

      ctx.effect(() => {
        const handle = createTabStore();
        const instance = handle.create();

        /* 给别的客户端插件用的门面：左侧右键菜单用它加「在新标签中打开」。
           cordis 服务是首选；同时挂一份 window 兜底，免得服务注册失败就整条链断掉。 */
        const service = {
          version: 1,
          listTabs: () => instance.getSnapshot().tabs.slice(),
          openSessionInTab: (sessionId) => {
            instance.actions.open(sessionId);
            ctx.uiWorkspace.openSession(sessionId);
            return sessionId;
          },
          openWorkspaceInTab: async (workspaceId) => {
            const sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId);
            instance.actions.open(sessionId);
            ctx.uiWorkspace.openSession(sessionId);
            return sessionId;
          },
        };
        const disposeService = (() => {
          try {
            if (ctx.reflect !== undefined && typeof ctx.reflect.provide === 'function') {
              return ctx.reflect.provide('projectTabs', service);
            }
          } catch (error) {
            console.warn('[dsh-project-tabs] service registration failed:', error);
          }
          return () => {};
        })();
        globalThis.__DSH_PROJECT_TABS__ = service;

        const disposeRegistration = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'project-tabs',
          order: -100,
          locale: NS,
          inject: () => ({
            tabsStore: instance,
            openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
            connectWorkspace: (workspaceId) => ctx.uiWorkspace.connectWorkspace(workspaceId),
            createWorkspace: (path) => ctx.workspaces.create({ path }),
            pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
            retainSession: (sessionId) => ctx.sessions.retain(sessionId, { source: 'projectTabs' }),
          }),
        }, ProjectTabsBar));

        console.info('[dsh-project-tabs] installed');

        return () => {
          disposeRegistration();
          disposeService();
          if (globalThis.__DSH_PROJECT_TABS__ === service) delete globalThis.__DSH_PROJECT_TABS__;
        };
      }, 'project-tabs: tab bar');
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions'];
    exports.name = 'project-tabs';
    return module.exports;
  },
});

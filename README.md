# dsh-project-tabs

给 **DSH 桌面端**加一排**浏览器式项目标签**：Windows 原生标题栏里「应用 / 编辑」菜单
右侧那块空白，变成一条标签栏。

```text
┌──────────────────────────────────────────────────────────────────────┐
│  应用  编辑   │  alpha   beta ×   gamma ×                │  － □ ×  │  ← 标签栏
├───────────────┴──────────────────────────────────────────────────────┤
│  工作区           │  会话正文（原版界面）                            │
│  ▸ alpha          │                                                  │
│  ▾ beta           │                                                  │
└───────────────────┴──────────────────────────────────────────────────┘
```

## 安装

**用 dsh 自带的插件安装器（推荐）：**

```sh
dsh plugin --profile desktop add dsh-project-tabs
```

桌面端也可以直接在界面里装：左侧栏「插件」→「添加插件」→ 填包名 → 安装 → 立即启用。

**从源码装（开发用）：** 克隆本仓库然后

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

默认装进 `desktop` profile（`-Profile web|both` 可选，`-Uninstall` 卸载，幂等可重跑）。
客户端半边改完硬刷新页面即可，宿主半边改完要重启桌面端。

## 一个标签是什么

**一个标签 = 一条会话**（session）。标签上**只显示工作区（项目）标题**；左边的状态点
告诉你它现在在干什么：

| 状态点 | 标签配色 | 含义 |
| --- | --- | --- |
| 转圈 | 品牌蓝底（选中时） | 正在跑 |
| 黄点 | **黄底** | 在等你审批 / 回答 |
| 对勾 | **绿底 + 加粗** | 已经跑完，你还没看过 |
| 灰点 | 中性 | 空闲 |

界面其余部分**完全是原版**：左侧工作区列表、右侧面板、会话正文、输入框都不变。
标签只决定「中间那一栏显示哪条会话」。

## 用法

| 操作 | 结果 |
| --- | --- |
| 点标签 | 切到那条会话 |
| 点标签上的 × / 中键点标签 | 关掉这个标签（**不动会话、不动工作区**） |
| 拖标签 | 调整顺序 |
| 右键标签 | 关闭 / 关闭其他 / 关闭右侧 / 复制项目路径 |
| 点 `+`（**紧跟在最后一个标签后面**） | 选一个已有项目，或「选择目录…」挑一个新目录 → 在新标签里打开 |
| 在左侧工作区行上右键 | 「在新标签中打开」（由 [dsh-sidebar-context-menu](https://github.com/miao-ge/dsh-sidebar-context-menu) 提供这一项） |

**侧边栏点会话时会怎样**：如果那条会话已经有标签，就跳过去；否则**在当前标签里打开**
（不会越点标签越多）。所以标签数量和你的项目数是同一个量级。

## 为什么切标签不像「在重新加载」

一开始确实像：0.2.0 里 `mainView` 只保留**一条**会话，切走的会话会被 `release` 掉本地
generation —— 它的 `SessionBinding`、已加载的历史窗口、实时 tail 全部销毁。
再切回去是**冷开**（`openState: 'loading'`），界面上就是「重新加载了会话内容」。

所以本插件对**每一个后台标签**都额外持一个
`sessions.retain(id, { source: 'projectTabs' })`：历史窗口和 tail 一直活着，切回去时
`ConversationMainPanel` 直接是 active 相位 —— 不闪、不等，落点就是你上次读的那条消息。
在跑的标签优先保留，最多同时保 `MAX_WARM_TABS = 10` 个（每个保活标签 = 一条实时事件流）。

滚动位置本身由平台记着：`dsh-client-ui-chat` 的 `chatScrollPositions` 以 sessionId 为键存
`{ anchorKey, anchorTop, scrollTop }`，切走时保存、切回时锚回那条消息
（`dsh-client-ui-chat/lib/client.js:12327 / 4313 / 4656 / 4964`）。

**还差什么（诚实说明）**：这是「从热数据里重新渲染一遍」，不是「页面一直挂在那儿」。
所以 **React 组件局部状态仍会复位** —— 最明显的是你展开的工具卡片 / 思考块会收起。
要连这个都保住，就得把每个标签的会话**同时挂载**，而 0.2.0 不允许复用官方的
`main.conversation` / `conversation.header`（`renderSlot` 有所有权校验），必须自己重新渲染
正文并放弃官方标题栏（面包屑、标题动作、右侧面板开关、View 标签页），代价明显。
真要做到「浏览器那样的独立页面」，只有 iframe 一条路，而桌面壳不允许
（preload 不在子框架运行）。详见文末「已知限制」。

标签列表持久化在 localStorage（`dsh.project.tabs.v1`），重启桌面端会恢复。

## 非 Windows / 浏览器里怎么办

插件会检测 `html[data-windows-titlebar]`：

- **有**（Windows 桌面）：贴进那 40px 标题栏，避开原生菜单和窗口按钮，不动页面布局。
- **没有**（macOS 桌面 / 浏览器）：降级成中栏顶部的一条 36px 标签栏，
  同时给中栏加 `padding-top` 把内容推下去；卸载时撤销。

## 和另一个插件的关系

本插件对外提供一个客户端服务 `projectTabs`（另有一份 `window.__DSH_PROJECT_TABS__`
兜底），让 `dsh-sidebar-context-menu` 的右键菜单能加「在新标签中打开」：

```js
const tabs = ctx.get('projectTabs') ?? globalThis.__DSH_PROJECT_TABS__;
const sessionId = await tabs.openWorkspaceInTab(workspaceId);   // 连接工作区 + 开标签 + 切过去
tabs.openSessionInTab(sessionId);                              // 直接给某条会话开标签
tabs.listTabs();                                               // [{ id, sessionId }]
```

没装那个插件时，本插件完全独立工作。

## 实现要点（改代码前先读）

- **挂载点**：`shell.overlay` 是唯一一个「root 作用域 + list + `replaceRisk:none`」的
  全窗口浮层插槽。Windows 下 frame 有 `padding-top: var(--dsh-windows-titlebar-height)`，
  而绝对定位的包含块是 padding box，所以 `top:0` 正好落在那 40px 里。
- **别抢地盘**：原生菜单宿主是 `[data-windows-menu]`（桌面 preload 用 shadow DOM 画的，
  `left: var(--dsh-windows-menu-start,48px)`），运行时量它的 rect；右上角窗口按钮用
  `env(titlebar-area-*)` 探针量。原生菜单宽度会随界面语言变，所以挂了 ResizeObserver。
- **切标签 = `ctx.uiWorkspace.openSession(sessionId)`**：0.2.0 里「当前显示的会话」
  就是 `retainedBy.mainView > 0` 的那一条，openSession 同步换掉这个引用。
- **不依赖构建**：bundle 是 classic script，只调 `window.__ModuleLoader__.load`。
  `require()` 用的是平台静态模块表（react、react/jsx-runtime、react-dom/client、
  client-store、ui-slots、ui-primitives、ui-dockkit），所以不需要打包器。
- 宿主半边 `lib/index.js` 是**故意空的**：它存在的唯一意义是让
  `@deepseek-ai/dsh-client-modules` 能从 Loader 条目里扫描到本包的 `dsh.client` 声明，
  这样 `lib/client.js` 才会作为 `/plugins/dsh-project-tabs/client.js` 提供给页面。

## 测试

```powershell
node scripts\smoke-test.mjs
```

离线跑，不需要浏览器 / 联网 / 安装 React：自带一个迷你 hook 运行时，
把 `react/jsx-runtime` 的产物当普通对象树来断言。覆盖模块加载、清单要求、
`apply` 接线、标签 store 的全部动作、组件渲染与回调，以及几处副作用
（标题栏几何 / 降级布局 / 后台保活 / 跟随侧边栏 / 清理消失的会话）。

## 已知限制

- 左侧工作区列表是**全局共享**的（它本来就是全局列表，内容在每个标签下都一样）。
- **展开/收起的工具卡片在切换标签后会复位** —— 这是「重新渲染」而不是「一直挂着」的
  唯一可见代价，也是下面那条路要解决的问题。
- 右侧面板跟着当前会话走。
- 打开 `+` 菜单时会列出全部工作区；工作区特别多时列表会很长（会按视口夹取）。
- `data-windows-titlebar` 与原生菜单都是桌面端的实现细节；如果 DSH 改了标题栏结构，
  标签栏会退回「中栏顶部」那种降级布局（不会报错）。

### 为什么不做成「真·多页面」（iframe / 同时挂载）

用户最初想要的是「每个标签就是一份完整独立的页面」。桌面端做不到插件级实现，原因：

1. **桌面壳不允许在子框架里启动客户端**：主窗口 `webPreferences` 没有开
   `nodeIntegrationInSubFrames`（`lib/main.js:11099-11107`），所以 iframe 里**没有 preload**，
   拿不到 `dsh-desktop:boot` 的注入，那份 DSH 根本起不来。`window.open` 也被
   `setWindowOpenHandler` 直接 deny（`:11109-11112`），插件开不了新窗口。
   唯一的绕法是让 iframe 走宿主的 SPA 回退去拿带注入的 index，再靠 `webServer.tapIndex`
   塞一个 `__DSH_TRANSPORT__.streamBaseUrl`（否则 WebSocket 连不上，见
   `dsh-api-gateway/lib/client.js:730`）—— 这依赖若干未公开行为，DSH 一升级就可能坏，
   而且每个标签是一整份客户端（内存按标签数线性增长）。
2. **同时挂载多条会话**技术上可行（ui-subagent 的侧边栏聊天就是这么做的：
   `sessions.retain(source:'sidebarChat')` + `SessionProvider` +
   `renderFactorySlot('conversation.content', { variant: 'embedded' })`），
   但**不能复用官方的主会话外壳**：`main.conversation` / `conversation.header` /
   `conversation.session.header` 都是 `single`/有所有权校验的槽，第三方只能重新渲染正文，
   于是会丢掉官方标题栏（面包屑、标题动作、右侧面板开关、View 标签页）和宽度拖拽条。
   这和「和原版界面完全一样」是矛盾的。

当前方案选了「官方外壳 + 热数据重渲染」，在保真度和成本之间取平衡。

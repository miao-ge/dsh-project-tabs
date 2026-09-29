/**
 * dsh-project-tabs — 宿主半边。
 *
 * 这里**故意什么都不做**。本插件的全部功能都在浏览器侧：
 * 标签栏、标签状态、会话切换、拖拽排序、持久化。
 *
 * 那为什么还需要这个文件？因为 DSH 的客户端插件发现机制（`@deepseek-ai/dsh-client-modules`）
 * 是**从宿主 Loader 的条目**里扫描每个包的 `dsh.client` 声明的：
 * 只有本包作为一行插件被真正挂载了，`lib/client.js` 才会被当作 `/plugins/dsh-project-tabs/client.js`
 * 提供给页面。所以这行「空插件」是客户端半边能被加载的前提。
 *
 * 刻意不声明 `inject`：不依赖任何宿主服务，也就不可能因为服务缺失而拖累整个 profile。
 */

/** 稳定的插件名（cordis 用它做 Loader 条目身份）。 */
export const name = 'project-tabs';

/**
 * 空实现：本插件没有宿主侧行为。
 * 保留这个函数是因为 cordis 要求一个可挂载的插件入口。
 */
export function apply() {}

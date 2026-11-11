# 开发与调试

本插件是一个 DSH bundle：宿主半边（Node）负责日志折叠与计价，浏览器半边负责界面。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：注册 `turnCost` 投影、`GET /api/turn-cost/state` 路由 |
| `cost-model.js` | 纯函数：会话日志折叠、人民币/美元计价、投影视图（无第三方依赖，可单测） |
| `billing.js` | 宿主侧会话汇总（全量会话、工作区聚合、账户余额、Excel 数据源） |
| `client.js` | 浏览器半边：页脚金额、明细弹窗、预算胶囊、余额提醒、设置页「计费明细统计」 |
| `cordis.patch.yml` | bundle 补丁，向配置插入本插件 |
| `locale/*.json` | 插件在界面里的标题与描述（zh/en） |
| `icon.svg` | 插件图标 |

## 本地调试

- 安装：用 `plugin_manager` 安装本目录（绝对路径），安装后强制刷新页面（⌘⇧R）。
- **浏览器半边**：profile 里是软链接，改完 `client.js` 刷新页面即生效。
- **宿主半边**：改动 `index.js`、`cost-model.js`、`billing.js` 后需要重新加载宿主模块；开发时建议 `remove_bundle` 后重新 `install_bundle`（仅禁用/启用不保证刷新模块）。
- 核对宿主折叠是否运行：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json` 中应出现 `turnCost` 行；数据路由为 `GET /api/turn-cost/state?scope=full|balance`。

## 提交前检查

1. `npm run check`（四个源文件 `node --check`）。
2. `npm pack --dry-run` 检查打包内容，不应包含测试数据、会话日志或本地路径。
3. 手动过一遍：页脚本轮/会话、两个明细弹窗、预算设置与超预算提示、余额提醒只提醒一次（含稍后/不再提醒）、设置页统计与币种切换、Excel 导出。
4. 兼容性：支持 DSH `>=0.2.2-alpha.3`；改动涉及较新槽位或服务时请同步更新 README 的兼容性表。

## 约定

- 不引入第三方运行时依赖；浏览器半边只 `require('react')`。
- 不读写其他插件的 DOM；新增界面请使用 DSH 的 slot。
- 不提交任何真实会话日志、账号信息或本地绝对路径。
- 数据只存本机 `localStorage`：`dsh.turn-cost.store.v1`、`dsh.turn-cost.settings.v1`、`dsh.turn-cost.budget.v1`、`dsh.turn-cost.reminder.v1`。

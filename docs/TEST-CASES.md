# dsh-plugin-turn-cost 测试用例文档

- 被测版本：`dsh-plugin-turn-cost` 1.4.4
- 代码仓库：`/Users/jerod/Documents/deepseek-harness/default-workspace/turn-cost`
- 文档日期：2026-11-16
- 测试类型：离线单元/集成测试（无网络、无真实 DSH 宿主重启）
- 关联自动化：`tests/cost-model.test.mjs`、`tests/selection-log.test.mjs`、`tests/price-catalog.test.mjs`、`tests/billing.test.mjs`、`tests/client.test.mjs`
- 运行方式：`node tests/<file>.test.mjs`（`npm run check` 仅做语法检查）

## 1. 优先级与判定口径

| 优先级 | 含义 |
| --- | --- |
| P0 | 核心计价/崩溃/金额错误；不通过则版本不可发布 |
| P1 | 金额、套餐判定、持久化等重要路径错误；有规避手段 |
| P2 | 统计口径、文案、边界、极端场景；不影响主流程 |

金额单位约定：宿主与投影内部使用“微元/微美元”（1e-6），显示层再换算为 `¥`/`$`。本文中的 `costMicro` 均指微元。

固定测试数据 `T1`（除特别说明外均使用）：

| 桶 | tokens |
| --- | --- |
| cacheRead（命中） | 1,000,000 |
| uncachedInput（未命中） | 500,000 |
| cacheWrite（缓存写入） | 250,000 |
| output（含推理） | 100,000 |
| total | 1,850,000 |

计价公式（`cost-model.js:371`、`:398`）：

```text
costMicro = round(hit×hit价×f + (uncached+write)×miss价×f + output×output价×f)
f = 1（峰时/legacy）或 0.5（谷时）
```

`cacheWrite` 按 `miss` 价计费（DeepSeek 未单列缓存写入价）。

## 2. 用例分布

| 区域 | 前缀 | 数量 |
| --- | --- | --- |
| A 计价数学 | `TC-PRICE-*` | 23 |
| B 订阅套餐识别 | `TC-PLAN-*` | 13 |
| C 每轮模型与推理强度 | `TC-MODEL-*` | 12 |
| D 会话汇总 | `TC-SESS-*` | 12 |
| E 持久化与版本 | `TC-PERSIST-*` | 13 |
| F UI 行为 | `TC-UI-*` | 26 |
| G 边界与回归 | `TC-EDGE-*` | 13 |
| 合计 | | 112 |

---

## A. 计价数学（TC-PRICE）

#### TC-PRICE-01 峰值 flash 人民币精确金额
- 优先级：P0
- 前置条件：无套餐凭据；`endedAt` 为北京时间周一 10:00；加载 T1。
- 步骤：折叠 `turn/start` → 带 usage 的 `assistant/message`（provider=`deepseek`，model=`deepseek-v4-flash`）→ `turn/end`。
- 预期：`pricing='deepseek'`、`period='peak'`、`costMicro=2340000`（¥2.34）、`costUsdMicro=351000`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-02 峰值 flash 美元精确金额
- 优先级：P0
- 前置条件：同 TC-PRICE-01；显示币种为 USD。
- 步骤：读取同一轮的 `costUsdMicro` 并由客户端 `entryMicro(entry,'USD')` 取数。
- 预期：`$0.351`；不得用 `2340000/7.1` 反算（反算约 $0.3296，是错误值）。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-PRICE-03 谷时 flash 五折
- 优先级：P0
- 前置条件：`endedAt` 为北京时间周一 20:00（谷时）。
- 步骤：同 TC-PRICE-01。
- 预期：`period='offpeak'`、`costMicro=1170000`（¥1.17）、`costUsdMicro=175500`（$0.1755）；`rates.cny.miss=1`、`rates.cny.output=4`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-04 pro 人民币计价
- 优先级：P0
- 前置条件：model=`deepseek-v4-pro`，峰时，T1。
- 步骤：折叠一轮。
- 预期：`costMicro=9750000`（¥9.75）；`pricing='deepseek'`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-05 pro 美元计价
- 优先级：P0
- 前置条件：同 TC-PRICE-04。
- 步骤：读取 `costUsdMicro`。
- 预期：`1430000`（$1.43）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-06 legacy（chat/reasoner）全天同价
- 优先级：P0
- 前置条件：model=`deepseek-chat` 或 `deepseek-reasoner`；分别取峰时与谷时。
- 步骤：各折叠一轮 T1。
- 预期：两次均 `costMicro=2000000`、`period='flat'`，谷时不打五折；UI 不显示（峰）/（谷）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-07 legacy 美元表
- 优先级：P1
- 前置条件：同 TC-PRICE-06；USD 显示。
- 步骤：读取 `costUsdMicro`。
- 预期：`280000`（$0.28），峰谷一致。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-08 缓存三桶分别计费
- 优先级：P0
- 前置条件：峰时 flash；构造仅命中、仅未命中、仅缓存写入、仅输出四组。
- 步骤：分别折叠并比较差值。
- 预期：1M 命中=40000；1M 未命中=2000000；1M 缓存写入=2000000（按 miss 价）；100k 输出=800000。四者线性可加。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-09 推理 token 计入 output 桶
- 优先级：P0
- 前置条件：usage 的 `outputTokens` 已包含推理 token（宿主语义），不额外传 `reasoningTokens`。
- 步骤：折叠 output=100,000 的一轮。
- 预期：按 output 价计 800000 微元；弹窗文案为“Output (incl. reasoning)”；不存在单独的推理加价行。
- 自动化：`tests/cost-model.test.mjs`（输出桶精确值通过）；文案为静态走查。

#### TC-PRICE-10 边界 08:59（谷）
- 优先级：P0
- 前置条件：北京时间周一 08:59。
- 步骤：调用 `isPeak()` / 折叠一轮。
- 预期：`false` / `period='offpeak'`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-11 边界 09:00（峰）
- 优先级：P0
- 前置条件：北京时间周一 09:00。
- 步骤：同上。
- 预期：`true` / `period='peak'`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-12 边界 11:59（峰）
- 优先级：P0
- 前置条件：周一 11:59。
- 预期：峰时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-13 边界 12:00（谷）
- 优先级：P0
- 前置条件：周一 12:00（午休边界）。
- 预期：谷时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-14 边界 13:59（谷）
- 优先级：P0
- 前置条件：周一 13:59。
- 预期：谷时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-15 边界 14:00（峰）
- 优先级：P0
- 前置条件：周一 14:00。
- 预期：峰时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-16 边界 17:59（峰）
- 优先级：P0
- 前置条件：周一 17:59。
- 预期：峰时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-17 边界 18:00（谷）
- 优先级：P0
- 前置条件：周一 18:00。
- 预期：谷时。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-18 周六/周日全天谷时
- 优先级：P0
- 前置条件：周六 10:00、周日 15:00。
- 预期：均 `isPeak=false`；工作日 10:00 为峰，用于对照。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-19 秒级时间戳与 UTC+8 换算
- 优先级：P1
- 前置条件：传入秒级 epoch（如 `1763266200`）与对应的 UTC 毫秒值。
- 步骤：`isPeak(sec)` 与 `isPeak(sec*1000)` 对比；另取 UTC 01:30（北京 09:30）与 UTC 04:30（北京 12:30）。
- 预期：秒级自动 ×1000；09:30 为峰、12:30 为谷；同一时刻两种入参结果一致。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PRICE-20 第三方目录价（USD）×7.10 ≈ CNY
- 优先级：P0
- 前置条件：fixture 目录价（USD/1M）；provider 非 deepseek、无套餐。
- 步骤：折叠一轮 T1。
- 预期：`pricing='catalog'`、`approxCny=true`、`costUsdMicro=1575000`、`costMicro=round(1575000×7.1)=11182500`；CNY 显示 `≈¥11.182`（三位小数、带 ≈）。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-PRICE-21 免费模型
- 优先级：P1
- 前置条件：目录价 input/output/cacheRead/cacheWrite 全为 0。
- 预期：`pricing='free'`、`costMicro=0`、`costUsdMicro=0`、`period='flat'`；UI 显示 `¥0`（不是 `¥??`）。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-PRICE-22 未知模型
- 优先级：P0
- 前置条件：provider/model 在目录中不存在。
- 预期：`pricing='unknown'`、两个金额均为 `null`、`missingTurns` 追加该轮；UI 显示 `¥??` 且会话显示 `≥`（若同时有已计价轮次）。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-PRICE-23 微元四舍五入只在合计处发生
- 优先级：P2
- 前置条件：峰时 flash，各桶各 1 token（0.04 + 2 + 8）。
- 预期：`costMicro=10`（10.04 四舍五入），不是逐桶取整后再相加的其它口径。
- 自动化：`tests/cost-model.test.mjs`（通过）。

---

## B. 订阅套餐识别（TC-PLAN）

#### TC-PLAN-01 仅订阅型 OAuth 的提供方
- 优先级：P0
- 前置条件：provider 元数据 `isSubscription:true` 且无 `apiKey` 路由。
- 步骤：`loadPriceCatalog()` + `setPriceBook()` 后折叠该 provider 的一轮。
- 预期：`pricing='plan'`、`plan=true`、金额 `null`；`session.planTurns` 加 1。
- 自动化：`tests/price-catalog.test.mjs`、`tests/cost-model.test.mjs`（通过）。

#### TC-PLAN-02 同时卖两种路线的提供方 + OAuth 授权
- 优先级：P0
- 前置条件：provider 同时有 `isSubscription:true` 与 `apiKey`；凭据记录为 grant（非 api-key）。
- 步骤：`planProvidersFromRecords([{key:'llm-pi-ai/openai',kind:'grant'}], ['openai'])`。
- 预期：返回 `['openai']`，按套餐计。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-03 同时卖两种路线的提供方 + API key
- 优先级：P0
- 前置条件：同 TC-PLAN-02，但凭据记录 `kind:'api-key'`。
- 预期：不返回该 provider；按目录价按量计费（不得显示“订阅额度”）。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-04 GLM `zai-coding-cn` 用 API key 必须按量计费
- 优先级：P0
- 前置条件：provider id `zai-coding-cn`，仅有 api-key 凭据，名称不含订阅字样。
- 预期：`planProvidersFromRecords` 不含它；`detectPlanProviders` 也不按 id 形状（`coding`）判套餐。这是 1.4.3 的回归点。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-05 非订阅 OAuth（OpenRouter）
- 优先级：P1
- 前置条件：provider 无 `isSubscription:true`，凭据为 grant。
- 预期：不判套餐；按目录价或 unknown 处理。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-06 `kind:'api-key'` 记录不计入 OAuth 授权集合
- 优先级：P1
- 前置条件：`oauthSubscriptions=['openai']`，记录 `[{key:'llm-pi-ai/openai',kind:'api-key'}]`。
- 预期：返回空数组；即使 provider 支持订阅，API key 也不是套餐凭据。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-07 非 `llm-pi-ai/` 前缀的凭据被忽略
- 优先级：P2
- 前置条件：记录 key 为 `other/openai` 或含多个 `/`。
- 预期：不参与套餐判定。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-08 订阅适配器显示名
- 优先级：P0
- 前置条件：provider 无 pi-ai 元数据；`llm.listProviders()` 返回的 name 含 `ChatGPT`、`Copilot`、`Antigravity`、`Subscription`、`订阅` 之一。
- 预期：`detectPlanProviders` 将这些 id 加入套餐集合（大小写不敏感）。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-09 名称大小写与 id 归一化
- 优先级：P2
- 前置条件：provider id `CHATGPT`、凭据 key `llm-pi-ai/chatgpt/sub-2`。
- 预期：统一小写后判为 `chatgpt`。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

#### TC-PLAN-10 凭据缺失
- 优先级：P1
- 前置条件：无任何凭据记录，provider 名称也不含订阅字样。
- 预期：不判套餐；有目录价则按量，无目录价则 unknown（`¥??`），不得凭空显示“订阅额度”。
- 自动化：`tests/price-catalog.test.mjs`（部分覆盖）、`tests/cost-model.test.mjs`（通过）。

#### TC-PLAN-11 套餐轮的展示与统计
- 优先级：P0
- 前置条件：单轮套餐 turn。
- 预期：`costMicro=null`、`plan=true`、`period='flat'`；UI 本轮按钮“本轮消耗订阅额度”，会话按钮“会话消耗订阅额度”；`session.planTurns=1`。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-PLAN-12 套餐 provider + 未知模型
- 优先级：P1
- 前置条件：provider 已判套餐，model 不在目录。
- 预期：仍为 `plan`（套餐判定先于模型分类），不得变成 `unknown`/`¥??`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-PLAN-13 同一 provider 同时存在 grant 与 api-key 记录
- 优先级：P1
- 前置条件：记录顺序任意，包含 `kind:'grant'` 与 `kind:'api-key'`。
- 预期：grant 胜出，判套餐（代码注释明确“grant wins”）。
- 自动化：`tests/price-catalog.test.mjs`（通过）。

---

## C. 每轮模型与推理强度（TC-MODEL）

#### TC-MODEL-01 从 `request/header` 取模型与提供方
- 优先级：P0
- 前置条件：`request/header` 的 `config` 有 provider/model。
- 步骤：折叠 header → assistant（route 相同）→ end。
- 预期：`entry.provider/model` 与 header 一致；`modelName` 取目录名。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-02 header 的 reasoningEffort 作为兜底
- 优先级：P0
- 前置条件：无 selection 记录。
- 预期：`entry.effort` 等于 header 的 `reasoningEffort`；页脚显示 ` High`。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-MODEL-03 `agent/pre-step` 选择记录覆盖 header
- 优先级：P0
- 前置条件：selectionLookup 返回 `{effort:'max'}`，header 为 `high`。
- 预期：`entry.effort='max'`（记录优先）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-04 无 header 时沿用最近一次 effort
- 优先级：P1
- 前置条件：第 1 轮 header 为 `high`，第 2 轮无 header、无 selection。
- 预期：第 2 轮 `effort='high'`（`state.lastEffort` 延续）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-05 既无 header 也无记录
- 优先级：P2
- 前置条件：冷启动第一轮即无 header。
- 预期：`effort=undefined`，页脚不显示等级后缀；不得编造 `medium`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-06 多步时最后一步的模型名生效
- 优先级：P1
- 前置条件：step 0 为 flash，step 1 为 pro；同一轮。
- 预期：`entry.modelName` 为最后一步（pro）的目录名；`tokens` 为两步之和；`model` 仍取第一步（用于计价分类）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-07 同一步重试只计一次
- 优先级：P0
- 前置条件：同一 `step` 有两次 `assistant/message`（第一次失败/重试）。
- 预期：后者覆盖前者，token 不累加；`steps` 中该 step 只有一份。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-08 多步 token 累加
- 优先级：P0
- 前置条件：step 0、step 1 各 T1。
- 预期：该轮 `tokens.total=3,700,000`，金额为单轮两倍。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-09 header 与 route 不匹配
- 优先级：P1
- 前置条件：header provider=`deepseek`，assistant route provider=`openai`。
- 预期：step 的 effort 不继承 header（`requestMatches=false`）；模型/提供方取 route；不得把 OpenAI 轮按 DeepSeek 价计。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-10 重放确定性
- 优先级：P0
- 前置条件：同一事件数组。
- 步骤：`foldAll()` 连续执行两次。
- 预期：两次 `JSON.stringify` 完全一致（无 `Date.now()` 泄漏到结果）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-11 `inheritedEventCount` 前缀裁剪
- 优先级：P1
- 前置条件：事件 seq 10/11/12，`inheritedEventCount=11`。
- 预期：seq<11 的 `turn/start` 被跳过，剩余事件不产生轮次；取 10 时整轮折叠。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-MODEL-12 无 route 归因的轮次
- 优先级：P2
- 前置条件：assistant/message 带 usage，但无 `source`，也无 header。
- 预期：`model='deepseek-flash'`（FALLBACK_MODEL），但因 provider 为 null，`pricing='unknown'`、金额 `null`；不得猜测价格。
- 自动化：`tests/cost-model.test.mjs`（通过，实测为 unknown）。

---

## D. 会话汇总（TC-SESS）

#### TC-SESS-01 已结算轮次金额冻结
- 优先级：P0
- 前置条件：先折叠第 1 轮，然后替换价格目录/套餐集合，再折叠第 2 轮。
- 预期：第 1 轮的 `costMicro` 不变；`sessionCostMicro` 为两轮之和，不回算历史。
- 自动化：`tests/cost-model.test.mjs`（通过，新增加固）。

#### TC-SESS-02 套餐轮不计入金额但计入轮数
- 优先级：P0
- 前置条件：套餐 1 轮 + 普通 1 轮。
- 预期：`sessionCostMicro` 只含普通轮；`session.planTurns=1`；`session.turns=2`。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-SESS-03 缺失轮导致 `≥` 语义
- 优先级：P0
- 前置条件：unknown 1 轮 + 已计价 1 轮。
- 预期：会话金额文本 `≥ ¥x`，`partial=true`；弹窗值前缀 `≥`。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-SESS-04 套餐轮导致 `≥`
- 优先级：P0
- 前置条件：plan 1 轮 + 已计价 1 轮。
- 预期：`partial=true`，会话显示 `≥`；套餐轮 token/金额不计入求和。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-SESS-05 `missingTurns` 精确记录
- 优先级：P1
- 前置条件：第 2、4 轮 unknown。
- 预期：`missingTurns=[2,4]`；重放幂等，不重复追加。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-SESS-06 人民币/美元汇总互不换算
- 优先级：P0
- 前置条件：两轮峰时 flash。
- 预期：`sessionCostMicro=4680000`；`sessionCostUsdMicro=702000`；USD 不是 CNY/7.1。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-SESS-07 会话 token 汇总
- 优先级：P1
- 前置条件：两轮 T1 + 一轮空轮。
- 预期：`session.tokens.total=3,700,000`（空轮为 0）；四个桶分别相加。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-SESS-08 会话级 Web 工具汇总
- 优先级：P1
- 前置条件：一轮 2 次 search（api 模式）+ 1 次 fetch。
- 预期：`session.web.search=2`、`fetch=1`、`feeMicro=2×5000+1×5000=15000`；会话金额含该费用。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-SESS-09 只汇总到当前轮
- 优先级：P0
- 前置条件：投影含 1–5 轮，当前显示第 3 轮。
- 预期：`rowFromEntries` 只累计 turn≤3；第 4/5 轮不计入“会话”金额。
- 自动化：`tests/client.test.mjs`（通过，多轮求和）。

#### TC-SESS-10 `pricedTurns` 不应包含空轮
- 优先级：P2
- 前置条件：仅 1 个 aborted（empty）轮。
- 预期：`view.session.pricedTurns=0`。
- 实际：当前为 1（`cost-model.js:823` 只减 missing 与 plan）。见 BUG-02。
- 自动化：`tests/cost-model.test.mjs`（已复现）。

#### TC-SESS-11 全免费会话
- 优先级：P2
- 前置条件：两轮 free 模型。
- 预期：会话金额 `¥0`（不是 `¥??`、也不是 `≥`）。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-SESS-12 空轮不显示、不改变会话下限
- 优先级：P1
- 前置条件：第 1 轮 empty，第 2 轮 normal。
- 预期：第 1 轮无页脚行；会话金额不因 empty 变成 `≥`；`partial=false`。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

---

## E. 持久化与版本（TC-PERSIST）

#### TC-PERSIST-01 投影 `stateVersion` 为 9
- 优先级：P0
- 前置条件：加载 `index.js`。
- 预期：注册的 `turnCost` 投影 `stateVersion===9`，`COST_MODEL_VERSION===9`。
- 自动化：静态检查 + `cost-model.test.mjs`（state.v=9 通过）。

#### TC-PERSIST-02 旧版本缓存行被丢弃
- 优先级：P1
- 前置条件：宿主缓存行 stateVersion=8。
- 预期：宿主按版本不一致丢弃并重放；不得混用旧金额。
- 自动化：静态（版本声明位于 `index.js`；宿主行为不在本仓库）。

#### TC-PERSIST-03 浏览器本地镜像版本校验
- 优先级：P0
- 前置条件：`localStorage['dsh.turn-cost.store.v1']` 为 `v:99` 或损坏 JSON。
- 预期：`store.getSession()` 返回 undefined，读取为空；不抛异常。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-PERSIST-04 投影视图写入本地镜像
- 优先级：P0
- 前置条件：`useProjection` 返回含 `turns` 的 view。
- 预期：每个 turn 以 `id` 为 key 写入；session 汇总、`usdPriceVersion` 一并写入；订阅者收到通知。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-PERSIST-05 `null` 金额原样保留
- 优先级：P1
- 前置条件：unknown 轮 `costMicro=null`。
- 预期：镜像中仍为 `null`，不得写成 0（否则会显示 ¥0 而非 ¥??）。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-PERSIST-06 USD 缓存版本不匹配时重算
- 优先级：P1
- 前置条件：镜像 `usdPriceVersion` 为旧值，token 与新 view 不同。
- 预期：不使用旧 `costUsdMicro`；按新价格重算或用官方 USD 字段。
- 自动化：静态（`entryCostMicro`），`tests/client.test.mjs` 覆盖正常版本路径。

#### TC-PERSIST-07 选择记录 800ms 防抖
- 优先级：P0
- 前置条件：临时 HOME；记录一次选择后等待 ~900ms。
- 预期：800ms 内不写盘；之后写盘一次；无未捕获异常。
- 自动化：`tests/selection-log.test.mjs`（通过）。

#### TC-PERSIST-08 原子写（tmp + rename）
- 优先级：P1
- 前置条件：写入过程中观察目录。
- 预期：先写 `turn-cost-selections.json.tmp` 再 rename；结束后无 `.tmp` 残留；中途崩溃不产生半截正式文件。
- 自动化：`tests/selection-log.test.mjs`（通过）。

#### TC-PERSIST-09 `session/flush` 触发立即落盘
- 优先级：P0
- 前置条件：记录选择后立即触发 `session/flush`。
- 预期：`flushSelections()` 清定时器并写盘；不得抛 `ReferenceError`（1.4.4 崩溃回归）。
- 自动化：`tests/selection-log.test.mjs`（通过）；`index.js:204` 静态核对。

#### TC-PERSIST-10 损坏的选择文件
- 优先级：P1
- 前置条件：文件内容非 JSON。
- 预期：按空存储处理，不崩溃；后续写入可覆盖。
- 自动化：`tests/selection-log.test.mjs`（通过）。

#### TC-PERSIST-11 选择记录字段校验
- 优先级：P1
- 前置条件：sessionId 为空、turn<1、provider/model 缺失。
- 预期：`rememberSelection` 直接忽略，不创建桶。
- 自动化：`tests/selection-log.test.mjs`（通过）。

#### TC-PERSIST-12 写盘期间的新选择不能丢
- 优先级：P2
- 前置条件：第一次 flush 正在进行（写文件慢），此时记录第二次选择并再次 flush。
- 预期：最终文件包含第二次选择。
- 实际：文件保留第一次记录（`selection-log.js:93-94` 先清定时器再返回进行中的 promise）。见 BUG-04。
- 自动化：`tests/selection-log.test.mjs`（已复现）。

#### TC-PERSIST-13 存储配额/隐私模式
- 优先级：P2
- 前置条件：`localStorage.setItem` 抛异常。
- 预期：不崩溃，且注释声称“保留内存副本”，后续读取应仍能拿到本轮记录。
- 实际：记录丢失（`write()` 只捕获异常，无内存副本）。见 BUG-06。
- 自动化：`tests/client.test.mjs`（已复现）。

---

## F. UI 行为（TC-UI）

#### TC-UI-01 页脚顺序
- 优先级：P0
- 前置条件：一轮 peak flash，effort=high。
- 预期：同一行从左到右为 `模型名` → ` High` → ` （峰）` → `本轮 ¥2.34` → `会话 ¥2.34`；模型段与按钮之间无换行。
- 自动化：`tests/client.test.mjs`（通过，DOM 顺序断言）。

#### TC-UI-02 峰时标记
- 优先级：P1
- 前置条件：`period='peak'`。
- 预期：模型名后显示 `（峰）`；本轮按钮内不重复标记。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-03 谷时标记
- 优先级：P1
- 前置条件：`period='offpeak'`。
- 预期：显示 `（谷）`。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-04 非峰谷模型无标记
- 优先级：P2
- 前置条件：legacy（flat）或第三方 catalog（flat）。
- 预期：不显示（峰）/（谷），即使 `peak=true`。
- 自动化：`tests/client.test.mjs`（通过，显式断言无标记）。

#### TC-UI-05 套餐轮文案
- 优先级：P0
- 前置条件：plan 轮。
- 预期：本轮按钮“本轮消耗订阅额度”；会话（仅套餐）为“会话消耗订阅额度”；不出现 `¥0`。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-06 未知模型文案
- 优先级：P0
- 前置条件：unknown 轮。
- 预期：本轮/会话均 `¥??`（USD 为 `$??`），不得显示 0 或空白。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-07 免费模型文案
- 优先级：P1
- 前置条件：free 轮。
- 预期：`¥0`；会话仅含免费轮时也是 `¥0`。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-08 会话金额为已显示金额之和
- 优先级：P0
- 前置条件：第 1 轮 ¥2.34、第 2 轮 ¥1.17。
- 预期：第 2 轮页脚会话显示 `¥3.51`（与逐轮四舍五入后的显示值一致）。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-09 部分计价会话显示 `≥`
- 优先级：P0
- 前置条件：plan/unknown + 已计价轮。
- 预期：`会话 ≥ ¥2.34`；`data-dsh-session-partial="true"`；弹窗金额前缀 `≥ `。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-10 纯套餐会话特殊文案
- 优先级：P1
- 前置条件：所有轮均为 plan（priced=0）。
- 预期：`会话消耗订阅额度`；不显示 `≥ ¥0`。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-11 本轮弹窗内容
- 优先级：P1
- 前置条件：点击“本轮 ¥2.34”。
- 预期：打开 `role=dialog`，标题“本轮费用明细”，含模型名、计费时段、token 分桶、金额合计 ¥2.34；点击背景关闭；Esc 关闭。
- 自动化：`tests/client.test.mjs`（打开/标题/金额/背景通过；Esc 依赖真实 document，静态）。

#### TC-UI-12 会话弹窗内容
- 优先级：P1
- 前置条件：点击“会话 ¥3.51”。
- 预期：标题“会话费用明细”，含范围（第 1–N 轮、计价轮数）、会话 token、合计；部分计价时值带 `≥`。
- 自动化：`tests/client.test.mjs`（通过，标题/≥/金额）。

#### TC-UI-13 显示项开关
- 优先级：P1
- 前置条件：设置 `showTurn=false`/`showSession=false`。
- 预期：分别隐藏本轮/会话按钮；两者都关时整行返回 null；另一项仍正确。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-14 预算胶囊文案
- 优先级：P1
- 前置条件：`showBudget` 默认开启；未设预算 / 已设 ¥18。
- 预期：未设时显示“未设置预算”类文案；已设时显示 `预算 ¥18`（英文 `Budget $18`）；货币符号在前。
- 自动化：静态走查（`client.js:4127`），未挂载组件。

#### TC-UI-15 窄布局预算胶囊
- 优先级：P2
- 前置条件：输入区容器宽度 ≤560px，或无容器且视口 <900px。
- 预期：胶囊只显示货币符号；宽度恢复后显示完整文案；面板仍可打开。
- 自动化：静态走查（`ComposerCostEntry` 的 `compactLabel` 逻辑）。

#### TC-UI-16 预算超支提示
- 优先级：P1
- 前置条件：会话费用 ≥ 预算。
- 预期：胶囊文字变为警示色；面板显示“已超出预算”；不弹系统对话框。
- 自动化：静态走查（`exceeded`/`budgetExceeded`）。

#### TC-UI-17 预算输入非法
- 优先级：P2
- 前置条件：输入 0、负数、空、非数字。
- 预期：不写盘，面板内显示“请输入有效金额”类错误；预算保持原值。
- 自动化：静态走查（`save()` 的 `value<=0` 分支）。

#### TC-UI-18 余额提醒阈值
- 优先级：P1
- 前置条件：账户余额 `recharge <= 阈值`（按币种各自阈值）。
- 预期：触发提醒，列出币种/余额/阈值；余额充足不提醒；未登录/不可用不误报。
- 自动化：静态走查（`balanceAlerts`/`remainingSummary`）。

#### TC-UI-19 余额提醒每日一次
- 优先级：P2
- 前置条件：同一自然日已提醒并关闭。
- 预期：写入 `mutedUntil=当日 24:00`；当日不再弹；次日重新提醒。
- 自动化：静态走查（`readReminderState`/`endOfLocalDay`）。

#### TC-UI-20 设置页阈值输入
- 优先级：P1
- 前置条件：设置页“提醒”卡片。
- 预期：CNY/USD 两个输入；350ms 防抖写盘；空值→null（不提醒）；非法值不覆盖。
- 自动化：静态走查（`BillingSettingsSection`）。

#### TC-UI-21 语言切换
- 优先级：P1
- 前置条件：locale 从 zh 切到 en。
- 预期：页脚/弹窗/设置页文案切英文；金额、货币符号、峰谷判定不变；`（峰）` 变英文标记。
- 自动化：静态（两套词典），未做双语快照。

#### TC-UI-22 币种切换
- 优先级：P0
- 前置条件：CNY ↔ USD。
- 预期：CNY 用 `costMicro`，USD 用 `costUsdMicro`；catalog 的 `≈` 只在 CNY 出现；切换后金额立即更新而非仅换符号。
- 自动化：`tests/client.test.mjs`（USD 路径通过）。

#### TC-UI-23 Excel 列与行结构
- 优先级：P0
- 前置条件：导出含分组行 + 2 个会话行。
- 预期：表头 `分组 | 会话 | ID | 时间 | 金额 | 轮次`；分组行只写标题与金额；会话行写标题/ID/时间/金额/轮次；金额三位小数以内；XML 特殊字符转义。
- 自动化：`tests/client.test.mjs` + `unzip -t` + `openpyxl` 实际打开（通过）。

#### TC-UI-24 Excel 只导出勾选会话
- 优先级：P1
- 前置条件：勾选父分组但取消部分子会话。
- 预期：只导出勾选的会话；未勾选的不出现；分组行只为含选中会话的组生成。
- 自动化：静态走查（导出前 `picked` 过滤）。

#### TC-UI-25 Excel 合计不重复计分组
- 优先级：P0
- 前置条件：分组 13.26，其下会话 3.51 + 9.75。
- 预期：合计行 13.26，不是 26.52（跳过 group 行）。
- 自动化：`tests/client.test.mjs`（通过）。

#### TC-UI-26 窗口缩放对齐
- 优先级：P2
- 前置条件：缩放窗口/侧栏开合改变输入区右边界。
- 预期：页脚右边缘跟随 composer 右边界（paddingRight 动态调整）；不遮挡发送按钮；<900px 时回退默认 anchor。
- 自动化：静态走查（`alignShift` 与 `subscribeComposerLayout`）。

---

## G. 边界与回归（TC-EDGE）

#### TC-EDGE-01 1.4.4 启动崩溃回归
- 优先级：P0
- 前置条件：记录一次轮次选择，宿主存活 >800ms，触发防抖写。
- 预期：定时器调用 `flushSelections`（不是未定义的 `flush`），无 `ReferenceError`，进程不退出；文件写入正确。
- 自动化：`tests/selection-log.test.mjs`（通过）；`index.js:204`、`selection-log.js:31` 静态核对。

#### TC-EDGE-02 中断轮（aborted）
- 优先级：P0
- 前置条件：`turn/start` 后无带 usage 的 assistant 消息，直接 `turn/end`。
- 预期：`empty=true`、金额 0、`period=null`；页脚不显示该轮；会话不因它变 `≥`。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-EDGE-03 零 token 轮
- 优先级：P1
- 前置条件：usage 的 `totalTokens=0`。
- 预期：视作 empty，不产生金额；不计入 `pricedTurns`（当前会计入，见 BUG-02）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-EDGE-04 会话第一轮
- 优先级：P0
- 前置条件：无 inherited 事件、无 lastEffort。
- 预期：正常计价；页脚只显示本轮/会话各一次；不因缺少历史而报错。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-EDGE-05 未知 provider
- 优先级：P1
- 前置条件：provider=`acme`，model 不在目录。
- 预期：`unknown`、`¥??`、进入 `missingTurns`；不按 DeepSeek 价猜测。
- 自动化：`tests/cost-model.test.mjs`、`tests/client.test.mjs`（通过）。

#### TC-EDGE-06 币种切换后的 USD 缓存
- 优先级：P2
- 前置条件：旧版本镜像只存了 CNY 金额，无 `costUsdMicro`，切到 USD。
- 预期：应能由 token 重算 USD（catalog 记录）或至少不显示 `¥??`。
- 实际：第三方模型 `classifyModel` 无结果时返回 null，显示 `$??`。见“疑似 BUG-08”。
- 自动化：静态（未构造旧镜像）。

#### TC-EDGE-07 “加载更早历史”
- 优先级：P1
- 前置条件：时间线先加载最近 3 轮，再加载更早 5 轮。
- 预期：会话金额不重复累加、不跳变；页脚仍取投影全量 turns。
- 自动化：静态（`readChatNodes` 仅用于回退路径；主路径用投影）。

#### TC-EDGE-08 畸形事件
- 优先级：P2
- 前置条件：`turn/start` turn=0、assistant 缺 usage、tool/result 缺 callId、turn/end 不匹配。
- 预期：逐条忽略，不抛异常，不产生脏轮次。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-EDGE-09 `web_search` 多 query 去重计数
- 优先级：P1
- 前置条件：`arguments.queries=['a','b','a','']`，callId 有效。
- 预期：计 2 次请求；工具失败（`isError=true`）计 0。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-EDGE-10 失败/中断的工具调用不计费
- 优先级：P1
- 前置条件：tool/call 后无 result，或 result `isError=true`。
- 预期：不计 search/fetch 费用；不残留到下一轮。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-EDGE-11 Messages 模式搜索
- 优先级：P1
- 前置条件：一轮 2 次 search + 2 次 `web/deepseek-search-llm-request`。
- 预期：`billedSearch=0`，搜索费 0（费用已含在 Messages token 内）；fetch 亦不计（webMode=messages）。
- 自动化：`tests/cost-model.test.mjs`（通过）。

#### TC-EDGE-12 首轮仅 fetch
- 优先级：P2
- 前置条件：会话第一轮只调用 `web_fetch`，无此前 search。
- 预期：按 1 次 fetch 计 5000 微元。
- 实际：`webMode` 仍为 null，`billedFetch=0`，费用 0。见“疑似 BUG-09”（代码注释承认该限制）。
- 自动化：`tests/cost-model.test.mjs`（已记录实际值）。

#### TC-EDGE-13 重复 `turn/end`
- 优先级：P2
- 前置条件：同一 turn 连续两个 `turn/end`。
- 预期：第二个被忽略（open 已为 null），不产生重复轮次/重复金额。
- 自动化：`tests/cost-model.test.mjs`（通过）。

---

## H. 国产模型人民币价目文件（TC-CNY，1.5.0）

覆盖 `prices/cny-models.json` + `cny-prices.js` + 宿主启动加载。自动化对应用例在 `tests/cny-prices.test.mjs`（同时由 `tests/run-all.mjs` 执行）。

| 编号 | 场景 | 期望 | 自动化 |
| --- | --- | --- | --- |
| TC-CNY-01 | 随包价目文件可解析 | 四个厂商（zhipu / moonshot / qwen / doubao）至少各一条，`match` 正则全部可编译 | ✅ |
| TC-CNY-02 | GLM-5.3 走官方人民币价 | provider `zai-coding-cn` 命中 8 / 28 / 2，精确无 `≈` | ✅ |
| TC-CNY-03 | 提供方限定 | 同一模型经 `openrouter` 转售时不套用官方人民币价，回落目录价 | ✅ |
| TC-CNY-04 | 输入长度分档 | GLM-5.1 在 32767 与 32768 输入 token 处切换 6/24 与 8/28 档 | ✅ |
| TC-CNY-05 | 输出长度分档 | GLM-4.7 输出 199 与 200 时分别按 2/8 与 3/14（输入 32K 以上为 4/16） | ✅ |
| TC-CNY-06 | 缓存命中计入分档输入 | 2K 未命中 + 31K 缓存命中 → 33K prompt，取宽档 | ✅ |
| TC-CNY-07 | 免费模型 | GLM-4.7-Flash 单价全 0，显示 ¥0 而非未知 | ✅ |
| TC-CNY-08 | 缓存写入单价 | Kimi k3.1-pro 的 `cacheWrite` 为 13（5 分钟 TTL） | ✅ |
| TC-CNY-09 | Qwen 固定缓存价 / 分档 | qwen-max 缓存命中 0.48；qwen3.7-plus 在 256K 处 2/8 → 6/24 | ✅ |
| TC-CNY-10 | 豆包分档 | seed-2.1-pro 6/30/1.2；seed-2.0-mini 在 32K 处 0.2 → 0.4 | ✅ |
| TC-CNY-11 | 套餐优先于 token 价 | provider 被判为订阅套餐时 `pricing='plan'`，不进入人民币表 | ✅ |
| TC-CNY-12 | 文件损坏 / 缺失 | 空书不崩溃，所有国产模型回落目录价 + `≈` 或 `¥??` | ✅ |
| TC-CNY-13 | 调价后重启生效 | 修改 JSON 并重启 DSH 后，历史投影版本升到 11 重放一次 | 手工（宿主日志 `turn-cost: CNY price file "…" loaded`） |

## 3. 缺陷与用例映射

| 缺陷 | 严重度 | 相关用例 | 状态 |
| --- | --- | --- | --- |
| BUG-01 billing 快照 token 恒为 0 | P2 | TC-SESS-07 的账单侧 | 已执行复现 |
| BUG-02 `pricedTurns` 把空轮算作已计价 | P2 | TC-SESS-10、TC-EDGE-03 | 已执行复现 |
| BUG-03 会话 token 漏掉套餐轮 | P2 | TC-SESS-07 | 已执行复现 |
| BUG-04 并发 flush 丢新选择 | P2 | TC-PERSIST-12 | 已执行复现 |
| BUG-05 `costPanelIcon` 重复定义 | P2 | —（无行为差异） | 静态 |
| BUG-06 存储失败时无内存副本 | P2 | TC-PERSIST-13 | 已执行复现 |
| BUG-07 `isPeak(0)` 回退到当前时间 | P2 | TC-PRICE-19（缺时间戳场景） | 静态 |
| 疑似 BUG-08 旧 USD 缓存缺字段显示 `$??` | P2 | TC-EDGE-06 | 静态，未复现 |
| 疑似 BUG-09 首轮 fetch 不计费 | P2 | TC-EDGE-12 | 已执行，属设计限制 |

## 4. 未覆盖与限制

1. **真实 pi-ai 价格目录不可读**：当前机器 `app.asar` 内未解包出 `pi-ai/dist/providers/data`，也没有 `app.asar.unpacked` 对应目录；价格目录相关用例全部使用 fixture，通过 `DSH_PI_AI_DATA` / `DSH_PI_AI_PROVIDERS` 注入。真实 GLM/ChatGPT/Copilot 元数据形状未验证。
2. **订阅适配器显示名无法核对**：`dsh-plugin-subscriptions` 不在本仓库，无法确认 Claude/Grok 适配器的实际 `name`；`SUBSCRIPTION_NAME_PATTERN` 不含 `claude`/`grok`/`codex`，若显示名就是裸产品名则会漏判（见疑似问题）。
3. **设置页/预算/提醒组件未真实挂载**：`BillingSettingsSection`、`ComposerCostEntry`、`BalanceReminder` 依赖 slots、DOM 尺寸与轮询；本次以静态走查为主，未做浏览器端 E2E。
4. **宿主投影缓存行为**：stateVersion 不匹配时由宿主丢弃缓存行，该逻辑在 DSH 宿主内，不在本仓库，无法执行验证。
5. **真实流式 usage**：`usageOf` 的 `stream` 兜底路径用合成数据覆盖，未接真实 provider 流。
6. **并发/崩溃时序**：选择记录的写盘竞态可稳定复现，但“进程在 rename 前被杀”的场景未做故障注入。

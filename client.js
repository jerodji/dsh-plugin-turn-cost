/**
 * Turn cost — Client half.
 *
 * Appends the estimated RMB cost of a completed Turn under its footer:
 *
 *     本轮 ¥0.01    会话 ¥0.01     (turn 1)
 *     本轮 ¥0.02    会话 ¥0.03     (turn 2)
 *     本轮 ¥0.03    会话 ¥0.06     (turn 3)
 *
 * Data comes from the Host half's `turnCost` Session projection: it folds the
 * whole durable Session log (every finished turn, plus the Session title), so a
 * footer shows the correct amount even when earlier turns are not loaded in the
 * chat window — nothing is recomputed from the loaded window. The projection is
 * mirrored into a small localStorage store (see `createTurnCostStore`) so other
 * features can reuse the per-turn/per-session record, and so the last known
 * values still render before the projection arrives.
 *
 * The window-based computation below is only a fallback for the case where the
 * Host projection is unavailable (for example the Host half failed to load).
 *
 * Pricing is DeepSeek's official CNY list price (checked 2026-11-11) per one
 * million tokens. Peak hours bill at the listed price; off-peak bills at 50%.
 *
 * The two amounts are separate click targets (no hover tooltip). Each opens a
 * floating dialog shaped like the shipped usage panel:
 *
 *  - 「本轮 ¥x」: two separate sections — a Token statistics section (turn id,
 *    model, peak/off-peak period, total tokens and per-bucket token counts) and
 *    a money detail section (bucket tokens × unit price = amount, turn total);
 *    the pricing caveats sit under the money detail.
 *  - 「会话 ¥y」: the Session record — priced tokens, total, scope, unpriced
 *    turns, Session id and note (no per-turn amount list).
 *
 * Clicking the backdrop or pressing Escape closes the open dialog.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-turn-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Peak-hour CNY list price per 1M tokens: cache hit / cache miss / output. */
    const PEAK_PRICES = {
      // deepseek-flash (DeepSeek-V4.1-Flash), also v4-flash aliases.
      flash: { hit: 0.04, miss: 2, output: 8 },
      // deepseek-v4-pro (DeepSeek-V4-Pro).
      pro: { hit: 0.3, miss: 9, output: 27 },
      // Retired deepseek-chat / deepseek-reasoner ids keep their flat price.
      legacy: { hit: 0.2, miss: 2, output: 3 },
    };

    /**
     * Peak-hour USD list price per 1M tokens (DeepSeek's official US$ table).
     * Not a flat FX conversion of the CNY table: per-model ratios differ, so
     * USD amounts are computed from these rates.
     */
    const USD_PRICES = {
      flash: { hit: 0.006, miss: 0.3, output: 1.2 },
      pro: { hit: 0.044, miss: 1.32, output: 3.96 },
      legacy: { hit: 0.028, miss: 0.28, output: 0.42 },
    };

    /** Stamped onto cached USD amounts so a future price revision can invalidate them. */
    const PRICE_VERSION_USD = 'deepseek-usd-2026-11-11';

    /** Assumed route when events carry no provider/model attribution. */
    const FALLBACK_MODEL = 'deepseek-flash';

    /** Off-peak bills at exactly half of the peak list price. */
    const OFF_PEAK_FACTOR = 0.5;

    /** Beijing is UTC+8 all year; peak windows are read in that offset. */
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

    /** Local store contract; bump when the persisted shape changes. */
    const STORE_VERSION = 1;
    const STORE_KEY = 'dsh.turn-cost.store.v1';

    /** Search/Fetch API list price: ¥5 per 1,000 successful requests. */
    const WEB_REQUEST_PRICE = 0.005;

    /** Search/Fetch API list price per successful request: ¥0.005 / $0.00075. */
    const WEB_REQUEST_PRICE_USD = 0.00075;

    /** Locale face captured in `apply`; drives which currency the UI shows. */
    let localeFace;

    /**
     * Approximate display-only conversion rate. Costs are NEVER converted with
     * it — they are always computed from the official price list of the active
     * currency. It exists only for figures that are natively reported in a
     * different currency (account balance / bonus wallets) and for a budget set
     * in one currency while the other is active. DeepSeek publishes no official
     * FX rate, so this is a rough, clearly-labelled estimate.
     */
    const APPROX_CNY_PER_USD = 7.1;

    function uiLocale() {
      try {
        if (localeFace && typeof localeFace.getLocale === 'function') {
          // The locale face returns its immutable snapshot ({active, locales,
          // revision}), not a plain id.
          let raw = localeFace.getLocale();
          if (raw && typeof raw === 'object') raw = raw.active ?? raw.locale ?? raw.id;
          if (typeof raw === 'string' && raw !== '') return raw;
        }
        if (localeFace && typeof localeFace.getSnapshot === 'function') {
          const snapshot = localeFace.getSnapshot();
          const raw = snapshot && (snapshot.active ?? snapshot.locale ?? snapshot.id);
          if (typeof raw === 'string' && raw !== '') return raw;
        }
      } catch {
        /* fall through to the default */
      }
      return 'zh';
    }

    /** Currency used when the user has not picked one: USD for English, else CNY. */
    function defaultCurrency() {
      return /^en\b/i.test(uiLocale()) ? 'USD' : 'CNY';
    }

    /**
     * Amounts follow the explicit 「币种」 setting (defaults to the UI language):
     * Chinese shows CNY (official ¥ list price), English shows USD (official US$
     * list price). Any other language keeps CNY.
     */
    function activeCurrency() {
      try {
        const settings = readDisplaySettings();
        if (settings && (settings.currency === 'USD' || settings.currency === 'CNY')) return settings.currency;
      } catch {
        /* displayState may not be initialized yet */
      }
      return defaultCurrency();
    }

    /** Localized currency name: 人民币/美元 in Chinese, CNY/USD in English. */
    function currencyName(currency) {
      const target = currency || activeCurrency();
      if (/^en\b/i.test(uiLocale())) return target === 'USD' ? 'USD' : 'CNY';
      return target === 'USD' ? '美元' : '人民币';
    }

    /** Convert a plain amount (not micro) between currencies with the display-only FX. */
    function convertAmount(value, from, to) {
      const amount = Number(value) || 0;
      if (from === to) return amount;
      if (from === 'CNY' && to === 'USD') return amount / APPROX_CNY_PER_USD;
      if (from === 'USD' && to === 'CNY') return amount * APPROX_CNY_PER_USD;
      return amount;
    }

    /** Convert an amount native in `from` to `to` with the approximate display FX. */
    function approxConvertMicro(micro, from, to) {
      const value = Number(micro) || 0;
      if (from === to) return value;
      if (from === 'CNY' && to === 'USD') return value / APPROX_CNY_PER_USD;
      if (from === 'USD' && to === 'CNY') return value * APPROX_CNY_PER_USD;
      return value;
    }

    function symbolFor(currency) {
      return (currency || activeCurrency()) === 'USD' ? '$' : '¥';
    }

    function priceTable(currency) {
      return (currency || activeCurrency()) === 'USD' ? USD_PRICES : PEAK_PRICES;
    }

    function webRequestPrice(currency) {
      return (currency || activeCurrency()) === 'USD' ? WEB_REQUEST_PRICE_USD : WEB_REQUEST_PRICE;
    }

    function webRequestMicro(currency) {
      return Math.round(webRequestPrice(currency) * 1e6);
    }

    const DICTIONARIES = {
      zh: {
        badge: '本轮 {amount}',
        peakTag: '(峰)',
        offPeakTag: '(谷)',
        session: '会话 {amount}',
        sessionPartial: '会话 ≥ {amount}',
        panelTitleTurn: '本轮费用明细',
        panelTitleSession: '会话费用明细',
        tipAmountTitle: '金额明细（{currency}）',
        tipAmountHit: '缓存命中输入：{tokens} tokens × {price}/百万 = {amount}',
        tipAmountMiss: '缓存未命中输入：{tokens} tokens × {price}/百万 = {amount}',
        tipAmountWrite: '缓存写入：{tokens} tokens × {price}/百万 = {amount}',
        tipAmountOutput: '输出（含推理）：{tokens} tokens × {price}/百万 = {amount}',
        tipAmountTotal: '本轮金额合计：{amount}',
        tipTurnId: '轮次 ID：{id}',
        tipModel: '模型：{model}',
        tipPeriod: '计费时段：{period}',
        periodPeak: '高峰时段（标准价）',
        periodOffPeak: '低谷时段（5 折）',
        periodFlat: '全天同价（无峰谷）',
        tipTokenSection: 'Token 统计',
        tipTokens: '本轮 tokens：{tokens}',
        tipTokenHit: '缓存命中输入：{tokens} tokens',
        tipTokenMiss: '缓存未命中输入：{tokens} tokens',
        tipTokenWrite: '缓存写入：{tokens} tokens',
        tipTokenOutput: '输出（含推理）：{tokens} tokens',
        tipWebSearchFree: '联网搜索：{count} 次',
        tipWebSearchFee: '联网搜索：{count} 次 × {price}/次 = {amount}',
        tipWebFetchFree: '网页抓取：{count} 次（本地抓取，免费）',
        tipWebFetchFee: '网页抓取：{count} 次 × {price}/次 = {amount}',
        tipWebMessages: '辅助 Messages 搜索：{count} 次（token 未计入）',
        tipMixed: '本轮经过 {count} 个模型路由，按首个路由计价。',
        tipAssumed: '未取到模型路由信息，按 deepseek-flash 估算。',
        tipNote:
          '按 DeepSeek 官网{currency}价目与本轮结束时间估算；联网搜索/抓取按成功请求 {webPrice}/1000 次计费，仅新版 Search/Fetch API 计入本轮，默认 Messages 搜索走辅助请求、其 token 未计入；法定节假日未剔除，跨峰谷的单轮存在误差。',
        tipSessionTitle: '会话累计（{currency}）',
        tipSessionId: '会话 ID：{id}',
        tipSessionTokens: '会话 tokens（已计价轮次）：{tokens}',
        tipSessionTotal: '会话合计：{amount}',
        tipSessionWeb: '其中联网工具费：{amount}',
        tipSessionScope: '统计范围：第 1–{turn} 轮，已计价 {priced} 轮',
        tipSessionMissing: '未计价轮次：{turns}',
        tipSessionNote:
          '会话金额为各轮「本轮」金额之和，每轮按其自身的模型与结束时段计价；后续新增对话不会改变历史轮次的金额。数据来自本地记录，无需加载更早的对话。',
        tipMoreTurns: '等 {count} 轮',
        sectionLabel: '计费明细统计',
        sectionTitle: '计费明细统计',
        sectionDesc: '余额提醒与会话计费统计。费用按所选币种对应的 DeepSeek 官方价目与每轮结束时间估算，数据来自本地会话记录。',
        balanceTitle: '余额提醒',
        balanceDesc: '当充值余额低于或等于提醒值时提醒；可分别设置人民币和美元，留空表示不提醒。',
        balanceHint: '余额按「充值余额」判断，赠金只作展示，不计入提醒比较。',
        thresholdCny: '人民币提醒值',
        thresholdUsd: '美元提醒值',
        thresholdSuffix: '元时提醒',
        balanceCurrent: '当前余额',
        balanceRecharge: '充值',
        balanceBonus: '赠金',
        balanceTotal: '合计',
        balanceUnavailable: '暂时无法读取账户余额',
        balanceSignedOut: '尚未登录 DeepSeek 账户',
        currencyLabel: '币种',
        currencyCny: '人民币',
        currencyUsd: '美元',
        currencyNote: '账户余额按 1 美元 ≈ ¥7.10 近似折算展示，仅用于显示。',
        thresholdHit: '已低于提醒值',
        thresholdOk: '高于提醒值',
        reminderActive: '当前余额已达到提醒条件，顶部会显示提醒卡片。',
        reminderTitle: '余额提醒',
        reminderBody: '{currency} 充值余额 {balance} ≤ 提醒值 {threshold}',
        reminderLater: '稍后提醒',
        reminderDismiss: '不再提醒',
        sessionsTitle: '会话计费统计',
        sessionsDesc: '共统计 {count} 个会话；按会话记录的模型与结束时间计价。',
        modeWorkspace: '按工作区树',
        modeDirectory: '按工作区目录',
        modeFlat: '单列表',
        groupLabel: '分组方式',
        groupExpand: '展开 {name}',
        groupCollapse: '折叠 {name}',
        sortLabel: '排序方式',
        sortName: '名称',
        sortTime: '时间',
        sortAsc: '正序',
        sortDesc: '倒序',
        sortJoin: ' · ',
        remaining: '剩余 {amount}',
        panelTitleRemaining: '账户剩余明细',
        remainingBalance: '账户余额',
        remainingBonus: '赠送余额',
        remainingTotal: '剩余合计',
        displayTitle: '显示项',
        displayDesc: '控制每轮对话底部显示哪些金额，以及是否显示输入框上方的「预算」按钮。',
        displayTurn: '展示本轮计费金额',
        displaySession: '展示会话计费金额',
        displayBudget: '显示会话预算设置',
        selectAll: '全选',
        selectNone: '取消全选',
        exportExcel: '导出为 Excel',
        exportEmpty: '当前没有选中',
        exportFailed: '生成 Excel 失败',
        exportClose: '关闭',
        selectSession: '选中该会话',
        selectGroup: '选中「{name}」下的全部会话',
        selectPartial: '部分选中',
        exportColGroup: '分组',
        exportColSession: '会话',
        exportColId: 'Session ID',
        exportColTime: '时间',
        exportColAmount: '金额（{currency}）',
        exportColTurns: '轮数',
        exportTotal: '总计',
        exportSheet: '计费明细',
        panelClose: '关闭',
        totalLine: '合计 {amount}（{count} 个会话）',
        rangeLabel: '时间范围',
        rangeToday: '当天',
        range7d: '7 天内',
        range30d: '1 个月内',
        range90d: '3 个月内',
        range180d: '半年内',
        range365d: '1 年内',
        rangeAll: '全部时间',
        emptyRange: '该时间范围内没有会话',
        budgetWord: '预算',
        budgetUnset: '预算',
        budgetTitle: '设置预算',
        budgetExceeded: '已超出预算',
        remainingTitle: '账户剩余',
        budgetUsed: '本会话已用',
        budgetCurrent: '当前预算',
        budgetUnsetHint: '未设置',
        budgetAmount: '预算金额（{currency}）',
        budgetPlaceholder: '例如 20',
        budgetHint: '达到预算后只做提醒，不会打断对话。',
        budgetInvalid: '请输入大于 0 的金额',
        budgetSave: '确认',
        budgetClear: '清除预算',
        budgetCancel: '取消',
        refresh: '刷新',
        loading: '读取中…',
        empty: '暂无会话数据',
        unknownDir: '未关联目录',
        copyHint: '复制 Session ID',
        copied: '已复制',
        errorLoad: '读取失败：{message}',
      },
      en: {
        badge: 'This turn {amount}',
        peakTag: '(peak)',
        offPeakTag: '(off-peak)',
        session: 'Session {amount}',
        sessionPartial: 'Session ≥ {amount}',
        panelTitleTurn: 'This turn’s cost',
        panelTitleSession: 'Session cost',
        tipAmountTitle: 'Cost breakdown ({currency})',
        tipAmountHit: 'Cache-hit input: {tokens} tokens × {price}/M = {amount}',
        tipAmountMiss: 'Cache-miss input: {tokens} tokens × {price}/M = {amount}',
        tipAmountWrite: 'Cache write: {tokens} tokens × {price}/M = {amount}',
        tipAmountOutput: 'Output (incl. reasoning): {tokens} tokens × {price}/M = {amount}',
        tipAmountTotal: 'Turn cost total: {amount}',
        tipTurnId: 'Turn ID: {id}',
        tipModel: 'Model: {model}',
        tipPeriod: 'Billing period: {period}',
        periodPeak: 'peak (list price)',
        periodOffPeak: 'off-peak (50%)',
        periodFlat: 'flat price (all day)',
        tipTokenSection: 'Token usage',
        tipTokens: 'Turn tokens: {tokens}',
        tipTokenHit: 'Cache-hit input: {tokens} tokens',
        tipTokenMiss: 'Cache-miss input: {tokens} tokens',
        tipTokenWrite: 'Cache write: {tokens} tokens',
        tipTokenOutput: 'Output (incl. reasoning): {tokens} tokens',
        tipWebSearchFree: 'Web searches: {count}',
        tipWebSearchFee: 'Web searches: {count} × {price}/request = {amount}',
        tipWebFetchFree: 'Web fetches: {count} (local fetch, free)',
        tipWebFetchFee: 'Web fetches: {count} × {price}/request = {amount}',
        tipWebMessages: 'Auxiliary Messages searches: {count} (tokens not included)',
        tipMixed: 'This turn used {count} model routes; priced with the first route.',
        tipAssumed: 'No model route was recorded; estimated with deepseek-flash.',
        tipNote:
          'Estimated from DeepSeek’s official {currency} price list and this turn’s end time. Web search/fetch bills {webPrice} per 1,000 successful requests and is included only through the new Search/Fetch API; searches in the default Messages mode run inside auxiliary requests whose tokens are not included. Statutory holidays are not subtracted, and a turn spanning peak and off-peak can be off.',
        tipSessionTitle: 'Cumulative session cost ({currency})',
        tipSessionId: 'Session ID: {id}',
        tipSessionTokens: 'Session tokens (priced turns): {tokens}',
        tipSessionTotal: 'Session total: {amount}',
        tipSessionWeb: 'Includes web-tool fees: {amount}',
        tipSessionScope: 'Range: turns 1–{turn}; {priced} priced',
        tipSessionMissing: 'Unpriced turns: {turns}',
        tipSessionNote:
          'The session figure is the sum of every turn’s amount, each priced with its own model and end time; adding later turns never changes earlier amounts. Values come from the local record, so earlier history does not need to be loaded.',
        tipMoreTurns: 'and {count} turns',
        sectionLabel: 'Billing details',
        sectionTitle: 'Billing details',
        sectionDesc:
          'Balance reminder and per-session billing statistics. Costs are estimated from DeepSeek’s official price list for the selected currency and each turn’s end time, using local Session records.',
        balanceTitle: 'Balance reminder',
        balanceDesc:
          'Remind when the recharged balance is at or below the threshold. Set a CNY and/or USD threshold; leave a field empty to disable it.',
        balanceHint: 'The comparison uses the recharged balance; bonus balance is shown for reference only.',
        thresholdCny: 'CNY threshold',
        thresholdUsd: 'USD threshold',
        thresholdSuffix: '',
        balanceCurrent: 'Current balance',
        balanceRecharge: 'recharged',
        balanceBonus: 'bonus',
        balanceTotal: 'total',
        balanceUnavailable: 'Account balance is unavailable right now',
        balanceSignedOut: 'Not signed in to a DeepSeek account',
        currencyLabel: 'Currency',
        currencyCny: 'CNY',
        currencyUsd: 'USD',
        currencyNote: 'Account balance is displayed with an approximate conversion at 1 USD ≈ ¥7.10; it is display-only.',
        thresholdHit: 'at or below threshold',
        thresholdOk: 'above threshold',
        reminderActive: 'The balance is already below the reminder threshold; a reminder card is shown at the top right.',
        reminderTitle: 'Balance reminder',
        reminderBody: '{currency} recharged balance {balance} ≤ threshold {threshold}',
        reminderLater: 'Remind me later',
        reminderDismiss: "Don't remind again",
        sessionsTitle: 'Session billing',
        sessionsDesc: '{count} sessions, priced with each turn’s own model and end time.',
        modeWorkspace: 'Workspace tree',
        modeDirectory: 'By workspace directory',
        modeFlat: 'Flat list',
        groupLabel: 'Group by',
        groupExpand: 'Expand {name}',
        groupCollapse: 'Collapse {name}',
        sortLabel: 'Sort by',
        sortName: 'Name',
        sortTime: 'Time',
        sortAsc: 'Ascending',
        sortDesc: 'Descending',
        sortJoin: ' · ',
        remaining: 'Left {amount}',
        panelTitleRemaining: 'Remaining balance',
        remainingBalance: 'Account balance',
        remainingBonus: 'Bonus balance',
        remainingTotal: 'Remaining total',
        displayTitle: 'Display',
        displayDesc: 'Choose which amounts appear under each turn, and whether the budget pill above the composer is shown.',
        displayTurn: 'Show turn cost',
        displaySession: 'Show session cost',
        displayBudget: 'Show session budget',
        selectAll: 'Select all',
        selectNone: 'Clear selection',
        exportExcel: 'Export to Excel',
        exportEmpty: 'Nothing is selected',
        exportFailed: 'Failed to build the Excel file',
        exportClose: 'Close',
        selectSession: 'Select this session',
        selectGroup: 'Select every session under “{name}”',
        selectPartial: 'Partially selected',
        exportColGroup: 'Group',
        exportColSession: 'Session',
        exportColId: 'Session ID',
        exportColTime: 'Time',
        exportColAmount: 'Amount ({currency})',
        exportColTurns: 'Turns',
        exportTotal: 'Total',
        exportSheet: 'Billing detail',
        panelClose: 'Close',
        totalLine: 'Total {amount} ({count} sessions)',
        rangeLabel: 'Time range',
        rangeToday: 'Today',
        range7d: 'Last 7 days',
        range30d: 'Last month',
        range90d: 'Last 3 months',
        range180d: 'Last 6 months',
        range365d: 'Last year',
        rangeAll: 'All time',
        emptyRange: 'No sessions in this time range',
        budgetWord: 'Budget',
        budgetUnset: 'Budget',
        budgetTitle: 'Set budget',
        budgetExceeded: 'Over budget',
        remainingTitle: 'Balance',
        budgetUsed: 'This session used',
        budgetCurrent: 'Current budget',
        budgetUnsetHint: 'not set',
        budgetAmount: 'Budget ({currency})',
        budgetPlaceholder: 'e.g. 20',
        budgetHint: 'Reaching the budget only shows a reminder; it never interrupts the conversation.',
        budgetInvalid: 'Enter an amount greater than 0',
        budgetSave: 'Confirm',
        budgetClear: 'Clear budget',
        budgetCancel: 'Cancel',
        refresh: 'Refresh',
        loading: 'Loading…',
        empty: 'No session data yet',
        unknownDir: 'No directory',
        copyHint: 'Copy Session ID',
        copied: 'Copied',
        errorLoad: 'Failed to load: {message}',
      },
    };

    function classifyModel(model) {
      const id = String(model || '').toLowerCase();
      if (id.includes('flash')) return 'flash';
      if (id.includes('pro')) return 'pro';
      if (id.includes('chat') || id.includes('reasoner')) return 'legacy';
      return undefined;
    }

    function isPeak(time) {
      const raw = Number(time);
      const stamp = raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.now();
      const date = new Date(stamp + BEIJING_OFFSET_MS);
      const day = date.getUTCDay();
      const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
      return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    }

    function priceRate(kind, peak, currency) {
      const table = priceTable(currency);
      const base = table[kind] || table.flash;
      const factor = kind === 'legacy' || peak ? 1 : OFF_PEAK_FACTOR;
      return {
        hit: base.hit * factor,
        miss: base.miss * factor,
        output: base.output * factor,
      };
    }

    /**
     * Peak/off-peak tag for the footer prefix, or '' when DeepSeek's peak and
     * off-peak prices do not apply (the retired deepseek-chat / reasoner ids
     * bill a flat price all day, so they carry no tag).
     */
    function periodTag(t, period) {
      if (period === 'peak') return t('peakTag');
      if (period === 'offpeak') return t('offPeakTag');
      return '';
    }

    /**
     * Peak/off-peak bucket of one turn record. New records carry `period`
     * directly (host fold stores it); records written by older versions are
     * derived from `peak` + `model`.
     */
    function periodOf(entry) {
      if (!entry) return undefined;
      if (entry.period === 'peak' || entry.period === 'offpeak' || entry.period === 'flat') {
        return entry.period;
      }
      if (entry.empty === true) return null;
      const kind = classifyModel(entry.model);
      if (kind === 'legacy') return 'flat';
      if (kind === undefined) return undefined;
      return entry.peak === true ? 'peak' : 'offpeak';
    }

    function group(value) {
      return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function priceText(value) {
      const amount = Number(value);
      if (!(amount > 0)) return '0';
      return trimZeros(amount.toPrecision(3));
    }

    function trimZeros(text) {
      return text.includes('e') ? text : text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }

    /** Amount text without the currency symbol, for labels that print it once. */
    function moneyAmount(value) {
      const amount = Number(value) || 0;
      if (!(amount > 0)) return '0';
      if (amount < 0.000001) return '<0.000001';
      if (amount < 0.01) return trimZeros(amount.toPrecision(2));
      return trimZeros(amount.toFixed(3));
    }

    function money(value, currency) {
      return `${symbolFor(currency)}${moneyAmount(value)}`;
    }

    /** The value a footer actually shows, so the session sum matches the rows. */
    function shownValue(amount, currency) {
      const text = money(amount, currency);
      if (text.includes('<')) return 0.000001;
      return Number(text.replace(/[^\d.]/g, '')) || 0;
    }

    function bucketsOf(usage) {
      return {
        hit: Number(usage.cacheReadTokens) || 0,
        miss: Number(usage.uncachedInputTokens) || 0,
        write: Number(usage.cacheWriteTokens) || 0,
        output: Number(usage.outputTokens) || 0,
      };
    }

    function costOf(buckets, price) {
      return (buckets.hit * price.hit + (buckets.miss + buckets.write) * price.miss + buckets.output * price.output) / 1e6;
    }

    function estimate(usage, model, time, currency) {
      const kind = classifyModel(model);
      if (kind === undefined) return undefined;
      const peak = isPeak(time);
      const price = priceRate(kind, peak, currency);
      const buckets = bucketsOf(usage);
      return { kind, peak, price, ...buckets, total: costOf(buckets, price) };
    }

    /**
     * Every pricing input of one turn, memoized on that turn's tokenUsage
     * object so a turn is always priced from its own route and end time.
     */
    const detailCache = new WeakMap();

    function detailFor(usage, time, currency) {
      if (!usage) return undefined;
      const key = currency || activeCurrency();
      let byCurrency = detailCache.get(usage);
      if (byCurrency === undefined) {
        byCurrency = new Map();
        detailCache.set(usage, byCurrency);
      }
      const cached = byCurrency.get(key);
      if (cached !== undefined) return cached;
      const routes = Array.isArray(usage.routes) ? usage.routes : [];
      const assumed = routes.length === 0;
      const model = assumed ? FALLBACK_MODEL : String(routes[0].model || FALLBACK_MODEL);
      const mixed = new Set(routes.map((route) => `${route.provider}\u0000${route.model}`)).size > 1;
      const info = { model, assumed, mixed, routes: routes.length, detail: estimate(usage, model, time, key) };
      byCurrency.set(key, info);
      return info;
    }

    function shownOf(detail) {
      return { text: money(detail.total), value: shownValue(detail.total) };
    }

    /**
     * One settled turn record's total in the requested currency, in micro
     * units. CNY records carry `costMicro` directly (Host fold); USD records
     * are re-priced from the same token buckets with the official US$ table,
     * because the two price lists are not a flat FX conversion of each other.
     */
    function entryMicro(entry, currency) {
      if (!entry || typeof entry !== 'object') return null;
      if (entry.empty === true) return 0;
      const target = currency || activeCurrency();
      if (target !== 'USD') {
        return entry.costMicro === null || entry.costMicro === undefined ? null : Number(entry.costMicro) || 0;
      }
      const kind = classifyModel(entry.model);
      if (kind === undefined) return null;
      const period = entry.period !== undefined && entry.period !== null ? entry.period : undefined;
      const peak = period !== undefined ? period === 'peak' : entry.peak === true;
      const tokens = entry.tokens || {};
      const buckets = {
        hit: Number(tokens.cacheRead) || 0,
        miss: Number(tokens.uncachedInput) || 0,
        write: Number(tokens.cacheWrite) || 0,
        output: Number(tokens.output) || 0,
      };
      const price = priceRate(kind, peak, 'USD');
      const tokenMicro = costOf(buckets, price) * 1e6;
      const billedSearch = Math.round((Number(entry.webSearchFeeMicro) || 0) / 5000);
      const billedFetch = Math.round((Number(entry.webFetchFeeMicro) || 0) / 5000);
      return Math.round(tokenMicro) + (billedSearch + billedFetch) * webRequestMicro('USD');
    }

    /**
     * One turn's amount in `currency`, preferring the USD value persisted by the
     * local store (0.9.0) so switching the 币种 back and forth never recomputes
     * an unchanged turn. The cached value is only reused when the token buckets
     * still match; stale caches fall back to a fresh computation.
     */
    function entryCostMicro(entry, currency, storedRecord) {
      const target = currency || activeCurrency();
      if (target !== 'USD') return entryMicro(entry, target);
      const turn = storedRecord && entry && entry.id ? storedRecord.turns && storedRecord.turns[entry.id] : undefined;
      const cached = turn ? turn.costUsdMicro : undefined;
      if (cached !== undefined && cached !== null) {
        const version = storedRecord && storedRecord.session ? storedRecord.session.usdPriceVersion : undefined;
        const a = entry.tokens || {};
        const b = (turn && turn.tokens) || {};
        const same =
          Number(a.total) === Number(b.total) &&
          Number(a.uncachedInput) === Number(b.uncachedInput) &&
          Number(a.cacheRead) === Number(b.cacheRead) &&
          Number(a.output) === Number(b.output);
        if ((version === undefined || version === PRICE_VERSION_USD) && same) return Number(cached) || 0;
      }
      return entryMicro(entry, target);
    }

    /** One settled turn's Search/Fetch fees in the requested currency. */
    function webFeeOf(entry, currency) {
      if (!entry || typeof entry !== 'object') return 0;
      if ((currency || activeCurrency()) === 'USD') {
        const billedSearch = Math.round((Number(entry.webSearchFeeMicro) || 0) / 5000);
        const billedFetch = Math.round((Number(entry.webFetchFeeMicro) || 0) / 5000);
        return ((billedSearch + billedFetch) * webRequestMicro('USD')) / 1e6;
      }
      return (Number(entry.webFeeMicro) || 0) / 1e6;
    }

    function tailFor(store, turnNumber) {
      if (!store || typeof store.turnDataSource !== 'function') return undefined;
      let items;
      try {
        items = store.turnDataSource(turnNumber, 'turn-tail').getSnapshot();
      } catch {
        return undefined;
      }
      if (!Array.isArray(items)) return undefined;
      let fallback;
      for (const item of items) {
        if (!item || Number(item.turn) !== turnNumber) continue;
        if (item.tokenUsage) return item;
        fallback = fallback || item;
      }
      return fallback;
    }

    /**
     * A turn's tail data: from the timeline location when it is loaded, else
     * from the node store (covers turns whose location is not materialized).
     */
    function tailAt(timeline, store, turnNumber) {
      if (timeline && timeline.turns && typeof timeline.turns.get === 'function') {
        const location = timeline.turns.get(turnNumber);
        const dataStore = location && location.data;
        if (dataStore && typeof dataStore.get === 'function') {
          try {
            const item = dataStore.get('turn-tail');
            if (item && Number(item.turn) === turnNumber) return item;
          } catch {
            /* fall back to the node store */
          }
        }
      }
      return tailFor(store, turnNumber);
    }

    function summarizeTurns(turns, t) {
      const head = turns
        .slice(0, 6)
        .map((turn) => `#${turn}`)
        .join(', ');
      return turns.length > 6 ? `${head} ${t('tipMoreTurns', { count: turns.length })}` : head;
    }

    /**
     * Sum of the displayed amounts of turns 1..N, where N is this turn.
     * `partial` marks a session whose earlier turns could not be priced.
     * Used only by the window fallback path.
     */
    function cumulativeFor(store, timeline, ownTurn, ownTail, ownInfo, t) {
      if (ownTurn < 1) return undefined;
      let sum = 0;
      let priced = 0;
      let tokens = 0;
      const missing = [];
      const amounts = [];
      for (let turn = 1; turn <= ownTurn; turn += 1) {
        const item = turn === ownTurn ? ownTail : tailAt(timeline, store, turn);
        if (!item) {
          missing.push(turn);
          continue;
        }
        const usage = item.tokenUsage;
        if (!usage) {
          // A turn that ended without any assistant text (e.g. the user
          // aborted it) shows no footer row; it also contributes nothing.
          if (item.closing === null) continue;
          missing.push(turn);
          continue;
        }
        if (!(Number(usage.totalTokens) > 0)) continue;
        const info = turn === ownTurn ? ownInfo : detailFor(usage, item.time);
        if (!info || !info.detail) {
          missing.push(turn);
          continue;
        }
        const shown = shownOf(info.detail);
        sum += shown.value;
        priced += 1;
        tokens += Number(usage.totalTokens) || 0;
        amounts.push({ turn, text: shown.text });
      }
      return { total: ownTurn, sum, priced, tokens, missing, amounts, partial: missing.length > 0 };
    }

    /** Token statistics only: model, period, total and per-bucket token counts. */
    function describeTokens(detail, usage, info, t) {
      const lines = [t('tipModel', { model: info.model })];
      lines.push(
        t('tipPeriod', {
          period: t(
            detail.kind === 'legacy' ? 'periodFlat' : detail.peak ? 'periodPeak' : 'periodOffPeak',
            {},
          ),
        }),
      );
      lines.push('');
      lines.push(t('tipTokenSection', {}));
      lines.push(t('tipTokens', { tokens: group(usage.totalTokens) }));
      if (detail.hit > 0) lines.push(t('tipTokenHit', { tokens: group(detail.hit) }));
      if (detail.miss > 0) lines.push(t('tipTokenMiss', { tokens: group(detail.miss) }));
      if (detail.write > 0) lines.push(t('tipTokenWrite', { tokens: group(detail.write) }));
      if (detail.output > 0) lines.push(t('tipTokenOutput', { tokens: group(detail.output) }));
      return lines;
    }

    /** Pricing caveats that belong under the money detail. */
    function describeTurnFoot(info, t) {
      const lines = [];
      if (info.mixed) lines.push(t('tipMixed', { count: info.routes }));
      if (info.assumed) lines.push(t('tipAssumed', {}));
      lines.push(
        t('tipNote', {
          currency: currencyName(),
          webPrice: `${symbolFor()}${priceText(webRequestPrice())}`,
        }),
      );
      return lines;
    }

    function describeSession(session, t) {
      const lines = [
        t('tipSessionTitle', { currency: currencyName() }),
        t('tipSessionTokens', { tokens: group(session.tokens) }),
        t('tipSessionTotal', { amount: `${session.partial ? '≥ ' : ''}${money(session.sum)}` }),
        t('tipSessionScope', { turn: session.total, priced: session.priced }),
      ];
      if (Number(session.webFee) > 0) lines.splice(3, 0, t('tipSessionWeb', { amount: money(session.webFee) }));
      if (session.sessionId) lines.push(t('tipSessionId', { id: session.sessionId }));
      if (session.partial) lines.push(t('tipSessionMissing', { turns: summarizeTurns(session.missing, t) }));
      lines.push(t('tipSessionNote', {}));
      return lines;
    }

    /** Per-bucket money breakdown of one turn: tokens × unit price = amount. */
    function turnAmountLines(detail, t) {
      if (!detail || !detail.price) return [];
      const price = detail.price;
      const lines = [t('tipAmountTitle', { currency: currencyName() })];
      const buckets = [
        ['tipAmountHit', detail.hit, price.hit],
        ['tipAmountMiss', detail.miss, price.miss],
        ['tipAmountWrite', detail.write, price.miss],
        ['tipAmountOutput', detail.output, price.output],
      ];
      for (const [key, tokens, rate] of buckets) {
        const count = Number(tokens) || 0;
        if (!(count > 0) || typeof rate !== 'number') continue;
        lines.push(
          t(key, {
            tokens: group(count),
            price: `${symbolFor()}${priceText(rate)}`,
            amount: money((count * rate) / 1e6),
          }),
        );
      }
      if (detail.web) {
        const web = detail.web;
        if (web.search > 0) {
          lines.push(
            web.searchFee > 0
              ? t('tipWebSearchFee', {
                  count: group(web.search),
                  price: `${symbolFor()}${priceText(webRequestPrice())}`,
                  amount: money(web.searchFee),
                })
              : t('tipWebSearchFree', { count: group(web.search) }),
          );
        }
        if (web.fetch > 0) {
          lines.push(
            web.fetchFee > 0
              ? t('tipWebFetchFee', {
                  count: group(web.fetch),
                  price: `${symbolFor()}${priceText(webRequestPrice())}`,
                  amount: money(web.fetchFee),
                })
              : t('tipWebFetchFree', { count: group(web.fetch) }),
          );
        }
        if (web.messages > 0) lines.push(t('tipWebMessages', { count: group(web.messages) }));
      }
      lines.push(t('tipAmountTotal', { amount: money(detail.total) }));
      return lines;
    }

    function translate(t, key, params) {
      if (typeof t !== 'function') return String(key);
      try {
        return t(key, params);
      } catch {
        return String(key);
      }
    }

    const MUTED = {
      fontSize: 'calc(12px + var(--dsh-content-font-delta, 0px))',
      lineHeight: 1.4,
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-tertiary)',
      whiteSpace: 'nowrap',
    };

    /** Footer trigger, styled like the shipped usage pill (same height/metrics). */
    const TRIGGER = {
      ...MUTED,
      height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
      padding: '6px 8px',
      borderRadius: 4,
      border: 'none',
      background: 'transparent',
      fontFamily: 'inherit',
      cursor: 'pointer',
    };

    /** Dialog card matching the shipped turn-usage detail panel. */
    const PANEL = {
      zIndex: 1100,
      boxSizing: 'border-box',
      width: 'max-content',
      minWidth: 'min(300px, calc(100vw - 24px))',
      maxWidth: 'min(440px, calc(100vw - 24px))',
      maxHeight: 'min(70vh, calc(100vh - 24px))',
      overflowY: 'auto',
      padding: 16,
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-specific-menu)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 'calc(12px + var(--dsh-content-font-delta, 0px))',
      lineHeight: 1.5,
      textAlign: 'left',
      cursor: 'auto',
    };
    const BACKDROP = {
      position: 'fixed',
      inset: 0,
      zIndex: 1099,
      background: 'transparent',
      cursor: 'default',
    };
    const PANEL_TITLE = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 16,
      marginBottom: 8,
      color: 'var(--dsw-alias-label-primary)',
      fontWeight: 500,
    };
    const PANEL_VALUE = { fontVariantNumeric: 'tabular-nums' };
    const PANEL_RULE = { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 };
    const PANEL_BODY = {
      display: 'flex',
      flexDirection: 'column',
      overflowWrap: 'anywhere',
      fontVariantNumeric: 'tabular-nums',
    };
    const PANEL_ICON = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 };
    const PANEL_ROW = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 16,
      padding: '2px 0',
    };
    const PANEL_ROW_LABEL = { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' };
    const PANEL_ROW_VALUE = {
      color: 'var(--dsw-alias-label-primary)',
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
      overflowWrap: 'anywhere',
      flex: '1 1 auto',
    };
    const PANEL_SECTION = {
      marginTop: 10,
      marginBottom: 2,
      color: 'var(--dsw-alias-label-primary)',
      fontWeight: 600,
    };
    const PANEL_NOTE = {
      marginTop: 8,
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'calc(11px + var(--dsh-content-font-delta, 0px))',
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
    };

    /** The small round currency glyph in a panel title (mirrors the usage dialog). */
    function costPanelIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
        },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', {
          d: 'M8.5 8.5 12 12.5l3.5-4M12 12.5V17M9.5 12.5h5M9.5 15h5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }


    /** Rough height of a dialog body so the side with more room can be chosen. */
    function estimatePanelHeight(lines, viewportHeight) {
      let total = 16 * 2 + 24 + 10; // padding + title row + rule
      for (const line of lines || []) {
        if (line === '') total += 8;
        else if (line.indexOf('：') > 0) total += 20;
        else if (line.length > 24) total += 34;
        else total += 22;
      }
      return Math.min(total, Math.max(0, viewportHeight - 16));
    }

    /**
     * The element that actually contains `position: fixed` children of `el`.
     * Normally that is the viewport, but any ancestor with a transform,
     * filter, backdrop-filter, perspective, `will-change` for one of those, or
     * `contain: paint|layout` becomes the containing block instead. The
     * composer seat sets `will-change: transform` while a conversation is
     * active, so fixed offsets have to be measured against that box, not the
     * window, otherwise the dialog drifts to the left when panels open.
     */
    function fixedContainingBlock(el) {
      if (typeof getComputedStyle !== 'function') return null;
      const doc = typeof document !== 'undefined' ? document : undefined;
      let node = el && el.parentElement;
      while (node && node.nodeType === 1 && node !== (doc && doc.body) && node !== (doc && doc.documentElement)) {
        let style;
        try {
          style = getComputedStyle(node);
        } catch {
          style = null;
        }
        if (style) {
          const willChange = String(style.willChange === undefined ? '' : style.willChange);
          const contain = String(style.contain === undefined ? '' : style.contain);
          if (
            (style.transform && style.transform !== 'none') ||
            (style.filter && style.filter !== 'none') ||
            (style.backdropFilter && style.backdropFilter !== 'none') ||
            (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none') ||
            (style.perspective && style.perspective !== 'none') ||
            /\b(transform|filter|backdrop-filter|perspective)\b/.test(willChange) ||
            /\b(paint|layout|strict|content)\b/.test(contain)
          ) {
            return node;
          }
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Anchor a panel beside one trigger: the panel's right edge stays on the
     * trigger's right edge, and it opens on whichever side has more room —
     * above normally, below when there is not enough space over the button.
     * It never covers the trigger row. All offsets are computed against the
     * real fixed-position containing block so side panels and the active
     * composer seat cannot shift the dialog horizontally.
     */
    function panelPosition(event, lines, preferSide) {
      try {
        if (!event || !event.currentTarget || typeof event.currentTarget.getBoundingClientRect !== 'function') {
          return undefined;
        }
        const trigger = event.currentTarget;
        const rect = trigger.getBoundingClientRect();
        const win = typeof window !== 'undefined' ? window : undefined;
        const width = win && typeof win.innerWidth === 'number' ? win.innerWidth : 0;
        const height = win && typeof win.innerHeight === 'number' ? win.innerHeight : 0;
        if (!(width > 0) || !(height > 0)) return undefined;
        let blockRect = null;
        try {
          const block = fixedContainingBlock(trigger);
          if (block && typeof block.getBoundingClientRect === 'function') blockRect = block.getBoundingClientRect();
        } catch {
          blockRect = null;
        }
        const originRight = blockRect && blockRect.width > 0 ? blockRect.right : width;
        const originTop = blockRect ? blockRect.top : 0;
        const originBottom = blockRect && blockRect.height > 0 ? blockRect.bottom : height;
        const originWidth = blockRect && blockRect.width > 0 ? blockRect.width : width;
        const originHeight = blockRect && blockRect.height > 0 ? blockRect.height : height;
        const panelWidth = Math.min(440, Math.max(300, originWidth - 24));
        const right = Math.max(8, Math.min(originRight - rect.right, originWidth - panelWidth - 8));
        const panelHeight = estimatePanelHeight(lines, originHeight);
        const spaceAbove = rect.top - originTop;
        const spaceBelow = originBottom - rect.bottom;
        const fitsAbove = spaceAbove >= panelHeight + 8;
        const fitsBelow = spaceBelow >= panelHeight + 8;
        const above =
          preferSide === 'above'
            ? true
            : preferSide === 'below'
              ? false
              : fitsAbove && fitsBelow
                ? spaceAbove >= spaceBelow
                : fitsAbove
                  ? true
                  : fitsBelow
                    ? false
                    : spaceAbove >= spaceBelow;
        return above
          ? { right, side: 'above', bottom: Math.max(8, originBottom - rect.top + 8) }
          : { right, side: 'below', top: Math.max(8, rect.bottom - originTop + 8) };
      } catch {
        return undefined;
      }
    }

    /** The small round currency glyph in a panel title (mirrors the usage dialog). */
    function costPanelIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
        },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', {
          d: 'M8.5 8.5 12 12.5l3.5-4M12 12.5V17M9.5 12.5h5M9.5 15h5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * Anchor a panel just above one trigger (so it never covers the buttons),
     * horizontally near the pointer when the click carries coordinates.
     */
    /** The chat node store, read through the stable `chat` hook. */
    function readChatNodes(props) {
      if (typeof props.useChat !== 'function') return undefined;
      let store;
      try {
        store = props.useChat((snapshot) => (snapshot ? snapshot.nodes : undefined));
      } catch {
        return undefined;
      }
      if (!store || typeof store.turnDataSource !== 'function') return undefined;
      // Before the chat view is registered the hook exposes the empty
      // snapshot store; treat it as absent instead of reporting a lower bound.
      if (typeof store.values === 'function' && store.values().length === 0) return undefined;
      return store;
    }

    /**
     * The conversation timeline, read through the stable `chat` hook.
     *
     * Its identity changes whenever the loaded window grows (earlier history
     * loaded, or a new turn starting/ending), which is exactly when fallback
     * sums must be recomputed.
     */
    function readChatTimeline(props) {
      if (typeof props.useChat !== 'function') return undefined;
      try {
        return props.useChat((snapshot) => (snapshot ? snapshot.timeline : undefined));
      } catch {
        return undefined;
      }
    }

    /**
     * The Host-side `turnCost` projection: per-turn records folded from the
     * whole durable Session log. Available without loading earlier history.
     */
    function readProjection(props) {
      if (typeof props.useProjection !== 'function') return undefined;
      try {
        return props.useProjection('turnCost');
      } catch {
        return undefined;
      }
    }

    function readSessionId(props) {
      if (typeof props.sessionId === 'string' && props.sessionId.length > 0) return props.sessionId;
      const header = props.turn && props.turn.header;
      if (header && typeof header.id === 'string' && header.id.length > 0) return header.id;
      return '';
    }

    /* ------------------------------------------------------------------ *
     * Lightweight local store (generic, reusable by other features)
     * ------------------------------------------------------------------ */

    function memoryStorage() {
      const rows = new Map();
      return {
        getItem: (key) => (rows.has(key) ? rows.get(key) : null),
        setItem: (key, value) => rows.set(key, String(value)),
        removeItem: (key) => rows.delete(key),
      };
    }

    function defaultStorage() {
      try {
        const storage = globalThis.localStorage;
        if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') return storage;
      } catch {
        /* privacy mode or no DOM: fall back to memory */
      }
      return memoryStorage();
    }

    function emptyTokens() {
      return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
    }

    /**
     * A small persistent record of per-turn and per-session costs.
     *
     * Shape (localStorage, key `dsh.turn-cost.store.v1`):
     *
     *   {
     *     v: 1,
     *     sessions: {
     *       '<sessionId>': {
     *         sessionId, title, priceVersion, updatedAt,
     *         turns: {
     *           '<sessionId>:<turn>': {
     *             id, turn, startedAt, endedAt, model, peak,
     *             tokens: {uncachedInput, cacheRead, cacheWrite, output, total},
     *             costMicro,        // 1e-6 CNY, null when unpriced
     *             empty,            // true for aborted/no-usage turns
     *           }
     *         },
     *         session: {costMicro, turns, pricedTurns, missingTurns, tokens}
     *       }
     *     }
     *   }
     *
     * Turn ids are `<sessionId>:<turn>` (stable and unique across sessions).
     */
    function createTurnCostStore(options) {
      const key = (options && options.key) || STORE_KEY;
      const storage = (options && options.storage) || defaultStorage();
      const listeners = new Set();

      function blank() {
        return { v: STORE_VERSION, sessions: {} };
      }

      function read() {
        try {
          const raw = storage.getItem(key);
          const parsed = raw === null ? undefined : JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || parsed.v !== STORE_VERSION) return blank();
          if (!parsed.sessions || typeof parsed.sessions !== 'object') return blank();
          return parsed;
        } catch {
          return blank();
        }
      }

      function write(data) {
        try {
          storage.setItem(key, JSON.stringify(data));
        } catch {
          /* quota or private mode: keep the in-memory copy */
        }
        for (const listener of Array.from(listeners)) {
          try {
            listener(data);
          } catch {
            /* a broken listener must not break the store */
          }
        }
      }

      function getSession(sessionId) {
        if (!sessionId) return undefined;
        return read().sessions[sessionId];
      }

      function upsertSession(view) {
        if (!view || typeof view !== 'object' || typeof view.sessionId !== 'string' || view.sessionId.length === 0) return;
        const data = read();
        const turns = {};
        for (const entry of Array.isArray(view.turns) ? view.turns : []) {
          if (!entry || typeof entry.id !== 'string') continue;
          const costMicro = entry.costMicro === null || entry.costMicro === undefined ? null : Number(entry.costMicro) || 0;
          turns[entry.id] = {
            id: entry.id,
            turn: Number(entry.turn) || 0,
            startedAt: Number(entry.startedAt) || 0,
            endedAt: Number(entry.endedAt) || 0,
            model: typeof entry.model === 'string' ? entry.model : null,
            peak: entry.peak === true,
            period: periodOf(entry) || null,
            tokens: {
              uncachedInput: Number(entry.tokens && entry.tokens.uncachedInput) || 0,
              cacheRead: Number(entry.tokens && entry.tokens.cacheRead) || 0,
              cacheWrite: Number(entry.tokens && entry.tokens.cacheWrite) || 0,
              output: Number(entry.tokens && entry.tokens.output) || 0,
              total: Number(entry.tokens && entry.tokens.total) || 0,
            },
            costMicro,
            // USD is derived once here and persisted, so switching the 币种
            // later reads the cached values instead of recomputing (0.9.0).
            costUsdMicro: (() => {
              try {
                return entryMicro(entry, 'USD');
              } catch {
                return null;
              }
            })(),
            empty: entry.empty === true,
            webSearchRequests: Number(entry.webSearchRequests) || 0,
            webFetchRequests: Number(entry.webFetchRequests) || 0,
            webMessagesRequests: Number(entry.webMessagesRequests) || 0,
            webSearchFeeMicro: Number(entry.webSearchFeeMicro) || 0,
            webFetchFeeMicro: Number(entry.webFetchFeeMicro) || 0,
            webFeeMicro: Number(entry.webFeeMicro) || 0,
            webSearchBilled: entry.webSearchBilled === true,
            webFetchBilled: entry.webFetchBilled === true,
          };
        }
        const session = view.session && typeof view.session === 'object' ? view.session : {};
        let usdTotal = 0;
        let usdPriced = 0;
        for (const turn of Object.keys(turns)) {
          const value = turns[turn].costUsdMicro;
          if (value === null || value === undefined) continue;
          usdTotal += Number(value) || 0;
          usdPriced += 1;
        }
        data.sessions[view.sessionId] = {
          sessionId: view.sessionId,
          title: typeof view.title === 'string' ? view.title : null,
          priceVersion: typeof view.priceVersion === 'string' ? view.priceVersion : null,
          updatedAt: Number(view.updatedAt) || 0,
          turns,
          session: {
            costMicro: Number(session.costMicro) || 0,
            costUsdMicro: usdTotal,
            usdPricedTurns: usdPriced,
            usdPriceVersion: PRICE_VERSION_USD,
            turns: Number(session.turns) || 0,
            pricedTurns: Number(session.pricedTurns) || 0,
            missingTurns: Array.isArray(session.missingTurns) ? session.missingTurns.slice() : [],
            tokens: {
              uncachedInput: Number(session.tokens && session.tokens.uncachedInput) || 0,
              cacheRead: Number(session.tokens && session.tokens.cacheRead) || 0,
              cacheWrite: Number(session.tokens && session.tokens.cacheWrite) || 0,
              output: Number(session.tokens && session.tokens.output) || 0,
              total: Number(session.tokens && session.tokens.total) || 0,
            },
            web: {
              search: Number(session.web && session.web.search) || 0,
              fetch: Number(session.web && session.web.fetch) || 0,
              messages: Number(session.web && session.web.messages) || 0,
              feeMicro: Number(session.web && session.web.feeMicro) || 0,
            },
          },
        };
        write(data);
      }

      function setSessionTitle(sessionId, title) {
        if (!sessionId) return;
        const data = read();
        const record = data.sessions[sessionId];
        if (!record) return;
        record.title = typeof title === 'string' ? title : null;
        write(data);
      }

      function removeSession(sessionId) {
        const data = read();
        if (!data.sessions[sessionId]) return;
        delete data.sessions[sessionId];
        write(data);
      }

      function sessionList() {
        return Object.values(read().sessions);
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      }

      return {
        version: STORE_VERSION,
        key,
        read,
        getSession,
        upsertSession,
        setSessionTitle,
        removeSession,
        sessionList,
        subscribe,
        clear: () => write(blank()),
      };
    }

    let store;
    function turnCostStore() {
      if (store === undefined) store = createTurnCostStore();
      return store;
    }
    try {
      globalThis.__DSH_TURN_COST_STORE__ = turnCostStore();
    } catch {
      /* no global object: the module export is still available */
    }

    /* ------------------------------------------------------------------ *
     * Projection-backed row (preferred) and window fallback
     * ------------------------------------------------------------------ */

    /**
     * Build one footer row from per-turn records: the turn amount plus the sum
     * of the displayed amounts of every turn up to and including this one.
     * Returns undefined when this turn itself has no priced record.
     */
    function rowFromEntries(entries, ownTurn, t, sessionId) {
      if (!Array.isArray(entries) || ownTurn < 1) return undefined;
      const currency = activeCurrency();
      const storedRecord = sessionId ? turnCostStore().getSession(sessionId) : undefined;
      const list = entries
        .filter((entry) => entry && Number(entry.turn) >= 1 && Number(entry.turn) <= ownTurn)
        .sort((left, right) => Number(left.turn) - Number(right.turn));
      const own = list.find((entry) => Number(entry.turn) === ownTurn);
      if (!own) return undefined;
      const ownCostMicro = entryCostMicro(own, currency, storedRecord);
      if (ownCostMicro === null || own.empty === true) return undefined;
      const tokens = own.tokens || {};
      if (!(Number(tokens.total) > 0)) return undefined;

      let sum = 0;
      let priced = 0;
      let sessionTokens = 0;
      let webFee = 0;
      const missing = [];
      const amounts = [];
      for (const entry of list) {
        if (entry.empty === true) continue;
        const costMicro = entryCostMicro(entry, currency, storedRecord);
        if (costMicro === null) {
          missing.push(Number(entry.turn));
          continue;
        }
        sum += shownValue(costMicro / 1e6, currency);
        webFee += webFeeOf(entry, currency);
        priced += 1;
        sessionTokens += Number(entry.tokens && entry.tokens.total) || 0;
        amounts.push({ turn: Number(entry.turn), text: money(costMicro / 1e6, currency) });
      }

      return {
        own,
        turnText: money(ownCostMicro / 1e6, currency),
        ownMicro: ownCostMicro,
        session: {
          total: ownTurn,
          sum,
          priced,
          tokens: sessionTokens,
          webFee,
          missing,
          amounts,
          partial: missing.length > 0,
          sessionId: sessionId || '',
        },
      };
    }

    function projectionTooltip(row, t) {
      const own = row.own;
      const currency = activeCurrency();
      const tokens = own.tokens || emptyTokens();
      const kind = classifyModel(own.model) || 'flash';
      const peak = own.peak === true;
      const price = priceRate(kind, peak, currency);
      const total = ((row.ownMicro !== undefined ? row.ownMicro : entryMicro(own, currency)) || 0) / 1e6;
      const web = {
        search: Number(own.webSearchRequests) || 0,
        fetch: Number(own.webFetchRequests) || 0,
        messages: Number(own.webMessagesRequests) || 0,
        searchFee: webFeeOf({ webSearchFeeMicro: own.webSearchFeeMicro }, currency),
        fetchFee: webFeeOf({ webFetchFeeMicro: own.webFetchFeeMicro }, currency),
        fee: webFeeOf(own, currency),
      };
      const detail = {
        kind,
        peak,
        price,
        hit: Number(tokens.cacheRead) || 0,
        miss: Number(tokens.uncachedInput) || 0,
        write: Number(tokens.cacheWrite) || 0,
        output: Number(tokens.output) || 0,
        total,
        web,
      };
      const usage = {
        totalTokens:
          Number(tokens.total) ||
          detail.hit + detail.miss + detail.write + detail.output,
      };
      const info = { model: own.model || FALLBACK_MODEL, assumed: !own.model, mixed: false, routes: 1 };
      const lines = describeTokens(detail, usage, info, t);
      if (own.id) lines.unshift(t('tipTurnId', { id: own.id }));
      return {
        turnLines: lines,
        turnFootLines: describeTurnFoot(info, t),
        sessionLines: describeSession(row.session, t),
        turnText: row.turnText,
        session: row.session,
        detail,
      };
    }

    function TurnCostBadge(props) {
      const t = (key, params) => translate(props.t, key, params);

      // Hook order is fixed: local UI state first, then every subscription,
      // all before any early return.
      const [panel, setPanel] = React.useState(null);
      const [hovered, setHovered] = React.useState(null);
      const store = readChatNodes(props);
      const timeline = readChatTimeline(props);
      const projection = readProjection(props);
      const sessionId = readSessionId(props);
      const [settings, setSettings] = React.useState(() => readDisplaySettings());
      const [alignShift, setAlignShift] = React.useState(0);
      const rowRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };

      const localStore = turnCostStore();
      React.useEffect(() => {
        if (projection && typeof projection === 'object' && Array.isArray(projection.turns)) {
          localStore.upsertSession(projection);
        }
      }, [projection]);

      React.useEffect(() => {
        const offDisplay = subscribeDisplaySettings((next) => setSettings(next));
        refreshDisplaySettings();
        return () => {
          offDisplay();
        };
      }, []);

      // Align the footer's 会话 pill right edge with the composer's 预算 pill:
      // both are absolutely-positioned overlays in different containers, so
      // measure our own row against the right edge published by the composer.
      React.useEffect(() => {
        const measure = () => {
          const node = rowRef.current;
          if (!node || typeof node.getBoundingClientRect !== 'function') return;
          let rect;
          try {
            rect = node.getBoundingClientRect();
          } catch {
            return;
          }
          const target = composerLayout.right;
          const next =
            target === null || !(rect.right > 0) ? 0 : Math.max(0, Math.round(rect.right - target - 4));
          setAlignShift((current) => (Math.abs(current - next) > 0.5 ? next : current));
        };
        measure();
        const off = subscribeComposerLayout(measure);
        const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
        if (hasWindow) window.addEventListener('resize', measure);
        return () => {
          off();
          if (hasWindow) window.removeEventListener('resize', measure);
        };
      }, []);

      React.useEffect(() => {
        if (settings.showBudget === false && panel !== null) setPanel(null);
      }, [settings.showBudget]);

      React.useEffect(() => {
        if (panel === null) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined;
        }
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') setPanel(null);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
          if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKeyDown);
          }
        };
      }, [panel === null]);

      const turn = props.turn;
      if (!turn || !turn.data || typeof turn.data.get !== 'function') return null;

      let tail;
      try {
        tail = turn.data.get('turn-tail');
      } catch {
        return null;
      }
      const ownTurn = Number((tail && tail.turn) || turn.turn) || 0;
      if (ownTurn < 1) return null;

      // 1. Host projection: complete per-turn record folded from the log.
      let turnLines;
      let turnFootLines;
      let sessionLines;
      let turnText;
      let session;
      let turnDetail;
      let tagPeriod;
      const entries = projection && Array.isArray(projection.turns) ? projection.turns : undefined;
      let row = entries === undefined ? undefined : rowFromEntries(entries, ownTurn, t, sessionId);
      // 2. Local store: last known record (instant display, survives reloads).
      if (row === undefined) {
        const recorded = sessionId ? localStore.getSession(sessionId) : undefined;
        if (recorded) row = rowFromEntries(Object.values(recorded.turns || {}), ownTurn, t, sessionId);
      }
      if (row !== undefined) {
        tagPeriod = periodOf(row.own);
        const built = projectionTooltip(row, t);
        turnLines = built.turnLines;
        turnFootLines = built.turnFootLines;
        sessionLines = built.sessionLines;
        turnText = built.turnText;
        session = built.session;
        turnDetail = built.detail;
      } else {
        // 3. Fallback: compute from the loaded window only. When this turn has
        // no exact usage we still render the session/remaining triggers.
        const usage = tail && tail.tokenUsage;
        const totalTokens = usage === undefined ? 0 : Number(usage.totalTokens) || 0;
        const info = usage !== undefined && totalTokens > 0 ? detailFor(usage, tail && tail.time) : undefined;
        turnLines = [];
        turnFootLines = [];
        sessionLines = [];
        turnText = undefined;
        session = undefined;
        turnDetail = undefined;
        tagPeriod = undefined;
        if (info && info.detail) {
          tagPeriod =
            info.detail.kind === 'legacy' ? 'flat' : info.detail.peak === true ? 'peak' : 'offpeak';
          turnLines = describeTokens(info.detail, usage, info, t);
          turnFootLines = describeTurnFoot(info, t);
          turnDetail = info.detail;
          turnText = shownOf(info.detail).text;
          session =
            store === undefined
              ? undefined
              : cumulativeFor(store, timeline, ownTurn, tail, info, t);
          if (session !== undefined) {
            session.sessionId = sessionId;
            sessionLines = describeSession(session, t);
          }
        }
      }

      const showTurn = settings.showTurn !== false;
      const showSession = settings.showSession !== false;
      const hasTurn = showTurn && turnText !== undefined;
      const hasSession = showSession && session !== undefined;
      if (!hasTurn && !hasSession) return null;

      const turnPanelLines =
        turnDetail === undefined
          ? []
          : [...turnLines, '', ...turnAmountLines(turnDetail, t), '', ...turnFootLines];
      const sessionPanelLines = session === undefined ? [] : sessionLines;
      const tag = periodTag(t, tagPeriod);
      const turnLabel =
        turnText === undefined ? undefined : tag === '' ? t('badge', { amount: turnText }) : `${tag} ${t('badge', { amount: turnText })}`;

      const sessionLabel =
        session === undefined
          ? undefined
          : t(session.partial ? 'sessionPartial' : 'session', { amount: money(session.sum) });
      const openPanelAt = (kind, event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        // Read the geometry while the event is still being dispatched. React
        // nulls `event.currentTarget` before a state updater runs, so computing
        // the anchor inside the updater silently fell back to the fixed
        // bottom-right default.
        const lines = kind === 'turn' ? turnPanelLines : sessionPanelLines;
        const pos = panelPosition(event, lines);
        setPanel((current) => (current && current.kind === kind ? null : { kind, pos }));
      };
      const toggleKey = (kind) => (event) => {
        if (!event) return;
        const key = event.key;
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          openPanelAt(kind, event);
        }
      };
      const anchor = panel && panel.pos ? panel.pos : { right: 24, bottom: 72 };
      const dialogLines = panel === null ? [] : panel.kind === 'turn' ? turnPanelLines : sessionPanelLines;
      const dialogTitle =
        panel === null ? '' : panel.kind === 'turn' ? t('panelTitleTurn', {}) : t('panelTitleSession', {});
      const dialogValue =
        panel === null
          ? ''
          : panel.kind === 'turn'
            ? turnDetail === undefined
              ? ''
              : shownOf(turnDetail).text
            : session === undefined
              ? ''
              : `${session.partial ? '≥ ' : ''}${money(session.sum)}`;

      // Same body treatment as the shipped usage dialog: label/value rows,
      // with section headings and plain notes.
      const dialogRows = dialogLines.map((line, index) => {
        if (line === '') return h('div', { key: `gap-${index}`, style: { height: 8 } });
        const colon = line.indexOf('：');
        if (colon > 0) {
          return h(
            'div',
            { key: `row-${index}`, style: PANEL_ROW },
            h('span', { style: PANEL_ROW_LABEL }, line.slice(0, colon)),
            h('span', { style: PANEL_ROW_VALUE }, line.slice(colon + 1)),
          );
        }
        if (line.length <= 24) {
          return h('div', { key: `row-${index}`, style: PANEL_SECTION }, line);
        }
        return h('div', { key: `row-${index}`, style: PANEL_NOTE }, line);
      });

      // Hover background matches the shipped action-row buttons.
      const triggerStyle = (kind) =>
        hovered === kind || (panel !== null && panel.kind === kind)
          ? { ...TRIGGER, background: 'var(--dsw-alias-interactive-bg-hover)' }
          : TRIGGER;
      const hoverHandlers = (kind) => ({
        onMouseEnter: () => setHovered(kind),
        onMouseLeave: () => setHovered((current) => (current === kind ? null : current)),
      });
      const trigger = (kind, attrs, label) =>
        h(
          'button',
          {
            type: 'button',
            'data-dsh-cost-toggle': kind,
            'aria-haspopup': 'dialog',
            'aria-expanded': panel !== null && panel.kind === kind ? 'true' : 'false',
            onClick: (event) => openPanelAt(kind, event),
            onKeyDown: toggleKey(kind),
            ...hoverHandlers(kind),
            style: triggerStyle(kind),
            ...attrs,
          },
          label,
        );

      return h(
        'div',
        {
          ref: rowRef,
          'data-dsh-turn-cost-row': 'true',
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 6,
            paddingRight: 4 + alignShift,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'baseline',
              gap: 0,
            },
          },
          hasTurn ? trigger('turn', { 'data-dsh-turn-cost': String(ownTurn) }, turnLabel) : null,
          hasSession
            ? trigger(
                'session',
                {
                  'data-dsh-session-cost': String(session.tokens),
                  'data-dsh-session-partial': session.partial ? 'true' : 'false',
                },
                sessionLabel,
              )
            : null,
        ),
        panel === null
          ? null
          : h('div', {
              key: 'backdrop',
              'data-dsh-cost-backdrop': 'true',
              onClick: () => setPanel(null),
              style: BACKDROP,
            }),
        panel === null
          ? null
          : h(
              'div',
              {
                key: 'panel',
                role: 'dialog',
                'aria-label': dialogTitle,
                'data-dsh-cost-panel': panel.kind,
                style: {
                  ...PANEL,
                  position: 'fixed',
                  ...(anchor.top !== undefined ? { top: anchor.top } : { bottom: anchor.bottom }),
                  ...(anchor.left !== undefined ? { left: anchor.left } : { right: anchor.right }),
                },
              },
              h(
                'div',
                { style: PANEL_TITLE },
                h(
                  'span',
                  { style: PANEL_ICON },
                  costPanelIcon(),
                  h(
                    'span',
                    { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    dialogTitle,
                  ),
                ),
                h('span', { style: PANEL_VALUE }, dialogValue),
              ),
              h('div', { style: PANEL_RULE, 'aria-hidden': true }),
              h('div', { style: PANEL_BODY, 'data-dsh-cost-detail': String(ownTurn) }, dialogRows),
            ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Settings page: balance reminder + session billing statistics.
     *
     * The Client half gets its data from the Host half's same-origin
     * `GET /api/turn-cost/state` route (see index.js): wallets, every Session's
     * folded cost/title/workspace. The page lives in its own
     * `settings.section` entry, right below 「账号与余额」.
     * ------------------------------------------------------------------ */

    const SETTINGS_KEY = 'dsh.turn-cost.settings.v1';
    const SETTINGS_EVENT = 'dsh-turn-cost:settings';
    /**
     * Reminder memory: one reminder per threshold crossing, shared by every
     * mounted overlay via localStorage.
     *   - `shown`  the current crossing was already announced (survives reloads);
     *   - `mutedUntil` epoch ms until which the user asked us to stay quiet.
     * Recovery (no wallet below its threshold, or the mute expired) clears both,
     * which re-arms the next crossing.
     */
    const REMINDER_KEY = 'dsh.turn-cost.reminder.v1';
    const DEFAULT_REMINDER = { shown: false, mutedUntil: 0 };
    function endOfLocalDay(now) {
      const end = new Date(now);
      end.setHours(24, 0, 0, 0);
      return end.getTime();
    }
    function readReminderState() {
      try {
        const raw = localStorage.getItem(REMINDER_KEY);
        const parsed = raw ? JSON.parse(raw) : undefined;
        if (parsed && parsed.v === 1) return { shown: parsed.shown === true, mutedUntil: Number(parsed.mutedUntil) || 0 };
      } catch {
        // fall through to the default (remind once per crossing)
      }
      return { ...DEFAULT_REMINDER };
    }
    function writeReminderState(next) {
      try {
        localStorage.setItem(
          REMINDER_KEY,
          JSON.stringify({ v: 1, shown: next.shown === true, mutedUntil: Number(next.mutedUntil) || 0 }),
        );
      } catch {
        // storage full/denied: still remind this session
      }
    }
    const STATE_URL = '/api/turn-cost/state';
    /** Session-statistics time filters, applied to each session's creation time. */
    const TIME_RANGES = ['today', '7d', '30d', '90d', '180d', '365d', 'all'];
    const TIME_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };

    const stateCache = { at: 0, data: undefined, scope: undefined, busy: undefined, busyScope: undefined };

    /** Fetch the Host snapshot (cached briefly so the overlay + page share it). */
    function fetchBillingState(scope, force = false) {
      const now = Date.now();
      if (!force && stateCache.data !== undefined && stateCache.scope === scope && now - stateCache.at < 15000) {
        return Promise.resolve(stateCache.data);
      }
      if (stateCache.busy !== undefined) {
        if (stateCache.busyScope === scope) return stateCache.busy;
        // Another surface is fetching a different depth; wait, then make sure
        // the data we render matches the depth this caller asked for.
        return stateCache.busy.catch(() => {}).then(() => fetchBillingState(scope, force));
      }
      stateCache.busyScope = scope;
      stateCache.busy = fetch(`${STATE_URL}?scope=${scope}`, {
        headers: { 'x-dsh-turn-cost': '1' },
        cache: 'no-store',
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => {
          stateCache.at = Date.now();
          stateCache.scope = scope;
          stateCache.data = data;
          return data;
        })
        .finally(() => {
          stateCache.busy = undefined;
        });
      return stateCache.busy;
    }

    function readThresholds() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const pick = (value) => {
          const n = Number(value);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const flag = (value) => value !== false;
        // `showBudget` superseded `showRemaining` in 0.5.7; keep reading the old
        // key so an existing install keeps the budget pill visible.
        const currency = parsed.currency === 'USD' ? 'USD' : parsed.currency === 'CNY' ? 'CNY' : undefined;
        return {
          cny: pick(parsed.cny),
          usd: pick(parsed.usd),
          currency,
          showTurn: flag(parsed.showTurn),
          showSession: flag(parsed.showSession),
          showBudget: flag(parsed.showBudget !== undefined ? parsed.showBudget : parsed.showRemaining),
          range: TIME_RANGES.indexOf(parsed.range) >= 0 ? parsed.range : 'all',
        };
      } catch {
        return {
          cny: null,
          usd: null,
          currency: undefined,
          showTurn: true,
          showSession: true,
          showBudget: true,
          range: 'all',
        };
      }
    }

    function writeThresholds(next) {
      const currency = next.currency === 'USD' ? 'USD' : next.currency === 'CNY' ? 'CNY' : undefined;
      const value = {
        cny: next.cny === null || next.cny === undefined ? null : Number(next.cny),
        usd: next.usd === null || next.usd === undefined ? null : Number(next.usd),
        currency,
        showTurn: next.showTurn !== false,
        showSession: next.showSession !== false,
        showBudget: next.showBudget !== false,
        range: TIME_RANGES.indexOf(next.range) >= 0 ? next.range : 'all',
      };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      } catch {
        // Storage can be unavailable; the page still works for this session.
      }
      // Keep the in-memory display settings and every mounted footer in sync
      // before the window event reaches them.
      try {
        refreshDisplaySettings();
      } catch {
        // displayState is not initialized yet (module bootstrap).
      }
      try {
        window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: value }));
      } catch {
        // No window (unit tests) — nothing to notify.
      }
      return value;
    }

    /** Live footer display preferences (mirrors localStorage; shared by every badge). */
    const displayState = { settings: null, listeners: new Set() };

    function readDisplaySettings() {
      if (displayState.settings === null) displayState.settings = readThresholds();
      return displayState.settings;
    }

    function refreshDisplaySettings() {
      displayState.settings = readThresholds();
      for (const listener of Array.from(displayState.listeners)) {
        try {
          listener(displayState.settings);
        } catch {
          // A broken subscriber must not break the rest.
        }
      }
      return displayState.settings;
    }

    function subscribeDisplaySettings(listener) {
      displayState.listeners.add(listener);
      return () => displayState.listeners.delete(listener);
    }

    /** Wallet totals, refreshed lazily and shared by every footer badge. */
    const balanceState = { account: undefined, loaded: false, at: 0, busy: undefined, listeners: new Set() };

    /**
     * Right edge of the composer's 预算 pill, published by the composer entry
     * and consumed by the turn footer so the 会话 pill can line up with it even
     * though the two live in different containers (and the sidebar can move
     * them independently).
     */
    const composerLayout = { right: null, listeners: new Set() };
    function publishComposerRight(right) {
      const next = typeof right === 'number' && Number.isFinite(right) ? right : null;
      if (composerLayout.right === next) return;
      composerLayout.right = next;
      for (const listener of [...composerLayout.listeners]) {
        try {
          listener(next);
        } catch (error) {
          console.error('[turn-cost] composer layout listener failed:', error);
        }
      }
    }
    function subscribeComposerLayout(listener) {
      composerLayout.listeners.add(listener);
      return () => composerLayout.listeners.delete(listener);
    }

    function publishBalance() {
      for (const listener of Array.from(balanceState.listeners)) {
        try {
          listener(balanceState.account);
        } catch {
          // ignore subscriber failures
        }
      }
    }

    function refreshBalance(force = false) {
      if (typeof fetch !== 'function') return Promise.resolve(undefined);
      const now = Date.now();
      if (!force && balanceState.loaded && now - balanceState.at < 60000) {
        return Promise.resolve(balanceState.account);
      }
      if (balanceState.busy !== undefined) return balanceState.busy;
      balanceState.at = now;
      balanceState.busy = fetchBillingState('balance', true).then(
        (state) => {
          balanceState.account = state && state.account ? state.account : null;
          balanceState.loaded = true;
          balanceState.busy = undefined;
          publishBalance();
          return balanceState.account;
        },
        () => {
          balanceState.account = null;
          balanceState.loaded = true;
          balanceState.busy = undefined;
          publishBalance();
          return undefined;
        },
      );
      return balanceState.busy;
    }

    function subscribeBalance(listener) {
      balanceState.listeners.add(listener);
      return () => balanceState.listeners.delete(listener);
    }

    /** Remaining = account balance + bonus balance (per currency). */
    function remainingSummary(account) {
      if (!account || account.status !== 'ready') return undefined;
      const wallets = Array.isArray(account.wallets) ? account.wallets : [];
      const items = [];
      for (const wallet of wallets) {
        if (wallet === null || wallet === undefined) continue;
        const recharge = Number(wallet.recharge) || 0;
        const bonus = Number(wallet.bonus) || 0;
        items.push({ currency: wallet.currency, recharge, bonus, total: recharge + bonus });
      }
      if (items.length === 0) return undefined;
      const primary = items.find((item) => item.currency === 'CNY') || items[0];
      return { items, primary };
    }

    function thresholdFor(thresholds, currency) {
      if (currency === 'CNY') return thresholds.cny;
      if (currency === 'USD') return thresholds.usd;
      return null;
    }

    /** Currencies whose recharge balance is at or below the configured threshold. */
    function balanceAlerts(state, thresholds) {
      const account = state && state.account;
      const wallets = account && Array.isArray(account.wallets) ? account.wallets : [];
      const alerts = [];
      for (const wallet of wallets) {
        const threshold = thresholdFor(thresholds, wallet.currency);
        if (threshold === null) continue;
        if (Number(wallet.recharge) <= threshold) {
          alerts.push({
            currency: wallet.currency,
            recharge: Number(wallet.recharge) || 0,
            bonus: Number(wallet.bonus) || 0,
            threshold,
          });
        }
      }
      return alerts;
    }

    function currencySymbol(currency) {
      return currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
    }

    function formatAmount(currency, value) {
      const number = Number(value) || 0;
      return `${currencySymbol(currency)}${number.toFixed(2)}`;
    }

    function moneyMicro(micro) {
      return money((Number(micro) || 0) / 1e6);
    }

    /**
     * Pick a Host record's amount in the active currency: the Host fold keeps
     * pairs (`costMicro` CNY, `costUsdMicro` USD) on sessions, workspaces and
     * totals.
     */
    function amountMicroIn(record) {
      if (!record || typeof record !== 'object') return 0;
      if (activeCurrency() === 'USD') return Number(record.costUsdMicro) || 0;
      return Number(record.costMicro) || 0;
    }

    function displayPath(path) {
      const parts = String(path || '')
        .split(/[\\/]/)
        .filter(Boolean);
      return parts.length === 0 ? String(path || '') : parts[parts.length - 1];
    }

    function copyTextToClipboard(text) {
      const fallback = () => {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', 'true');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
          return true;
        } catch {
          return false;
        }
      };
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).then(
            () => true,
            () => fallback(),
          );
        }
      } catch {
        // fall through
      }
      return Promise.resolve(fallback());
    }

    const CARD = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    };

    const CARD_TITLE = {
      margin: 0,
      fontSize: 'calc(14px + var(--dsh-content-font-delta, 0px))',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };

    const HINT = {
      margin: 0,
      fontSize: 'calc(12px + var(--dsh-content-font-delta, 0px))',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const PAGE_TEXT = {
      fontSize: 'calc(13px + var(--dsh-content-font-delta, 0px))',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-secondary)',
    };

    const INPUT = {
      width: 96,
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 'calc(13px + var(--dsh-content-font-delta, 0px))',
      fontVariantNumeric: 'tabular-nums',
      outline: 'none',
    };

    const SMALL_BUTTON = {
      height: 26,
      padding: '0 10px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 'calc(12px + var(--dsh-content-font-delta, 0px))',
      cursor: 'pointer',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    };

    /**
     * Open-settings reminder: one frame-wide card per threshold crossing.
     * Clicking 「不再提醒」 silences it until the balance recovers above the
     * threshold (then dips again); 「稍后提醒」 silences it until local midnight.
     * Both choices survive reloads.
     */
    function BalanceReminder(props) {
      const t = (key, params) => translate(props.t, key, params);
      const [state, setState] = React.useState(undefined);
      const [thresholds, setThresholds] = React.useState(() => readThresholds());
      const [reminder, setReminder] = React.useState(() => readReminderState());
      const [open, setOpen] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetchBillingState('balance').then(
            (data) => {
              if (alive) setState(data);
            },
            () => {
              if (alive) setState(null);
            },
          );
        };
        load();
        const timer = setInterval(load, 60000);
        const onSettings = (event) => {
          const detail = event && event.detail;
          setThresholds(detail && typeof detail === 'object' ? detail : readThresholds());
          load();
        };
        window.addEventListener(SETTINGS_EVENT, onSettings);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener(SETTINGS_EVENT, onSettings);
        };
      }, []);

      const loaded = state !== undefined && state !== null;
      const alerts = loaded ? balanceAlerts(state, thresholds) : [];
      const alertCount = alerts.length;

      // Re-arm when the crossing ends (balance recovered, threshold raised) or
      // when a 「稍后提醒」 mute expired.
      React.useEffect(() => {
        if (!loaded) return;
        if (alertCount > 0 && !(reminder.mutedUntil > 0 && Date.now() >= reminder.mutedUntil)) return;
        if (!reminder.shown && reminder.mutedUntil === 0) return;
        const next = { ...DEFAULT_REMINDER };
        setReminder(next);
        writeReminderState(next);
        setOpen(false);
      }, [loaded, alertCount, reminder.shown, reminder.mutedUntil]);

      // Announce the crossing exactly once (persisted, so reloads stay quiet
      // and the card stays visible until it is dismissed).
      React.useEffect(() => {
        if (!loaded || alertCount === 0 || open) return;
        if (reminder.shown) return;
        if (reminder.mutedUntil > 0 && Date.now() < reminder.mutedUntil) return;
        const next = { shown: true, mutedUntil: 0 };
        setReminder(next);
        writeReminderState(next);
        setOpen(true);
      }, [loaded, alertCount, open, reminder.shown, reminder.mutedUntil]);

      if (!open || alertCount === 0) return null;

      const dismissForever = () => {
        const next = { shown: true, mutedUntil: 0 };
        setReminder(next);
        writeReminderState(next);
        setOpen(false);
      };
      const remindLater = () => {
        const next = { shown: false, mutedUntil: endOfLocalDay(Date.now()) };
        setReminder(next);
        writeReminderState(next);
        setOpen(false);
      };

      return h(
        'div',
        {
          'data-dsh-balance-reminder': 'true',
          style: {
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 1300,
            maxWidth: 340,
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid var(--dsw-alias-state-warn-primary)',
            background: 'var(--dsw-alias-bg-overlay)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.24)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'auto',
          },
        },
        h('div', { style: { ...PAGE_TEXT, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('reminderTitle')),
        ...alerts.map((alert) =>
          h(
            'div',
            { key: alert.currency, style: HINT },
            t('reminderBody', {
              currency: alert.currency === 'USD' ? '$' : '¥',
              balance: formatAmount(alert.currency, alert.recharge),
              threshold: formatAmount(alert.currency, alert.threshold),
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: SMALL_BUTTON, onClick: remindLater }, t('reminderLater')),
          h('button', { type: 'button', style: SMALL_BUTTON, onClick: dismissForever }, t('reminderDismiss')),
        ),
      );
    }

    function SessionRow(props) {
      const { t, session, copied, onCopy, selectable, selected, onToggle } = props;
      const title = session.title || `${session.sessionId.slice(0, 8)}…`;
      const copiedHere = copied === session.sessionId;
      return h(
        'div',
        {
          'data-dsh-billing-session': session.sessionId,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 0',
            minWidth: 0,
          },
        },
        selectable
          ? h('input', {
              type: 'checkbox',
              checked: selected === true,
              'data-dsh-billing-select': 'session',
              'data-dsh-session-id': session.sessionId,
              'aria-label': t('selectSession'),
              onChange: () => onToggle(session.sessionId),
              style: {
                flex: '0 0 auto',
                margin: 0,
                width: 14,
                height: 14,
                cursor: 'pointer',
                accentColor: 'var(--dsw-alias-brand-primary)',
              },
            })
          : null,
        h(
          'span',
          {
            title: session.title || session.sessionId,
            style: {
              ...PAGE_TEXT,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          title,
        ),
        h(
          'button',
          {
            type: 'button',
            title: t('copyHint'),
            'aria-label': t('copyHint'),
            'data-dsh-copy-session': session.sessionId,
            onClick: (event) => {
              event.stopPropagation();
              onCopy(session.sessionId);
            },
            style: {
              ...SMALL_BUTTON,
              height: 22,
              padding: '0 6px',
              color: copiedHere ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
            },
          },
          copiedHere ? t('copied') : '⧉',
        ),
        h(
          'span',
          {
            style: {
              ...MUTED,
              minWidth: 72,
              textAlign: 'right',
              color: session.error ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
            },
          },
          session.error ? '—' : moneyMicro(amountMicroIn(session)),
        ),
      );
    }

    /** Start of a preset window (0 = no lower bound), judged in local time. */
    function rangeStart(range, now) {
      if (range === 'all') return 0;
      if (range === 'today') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start.getTime();
      }
      const days = TIME_RANGE_DAYS[range] || 0;
      return days > 0 ? now - days * 24 * 60 * 60 * 1000 : 0;
    }

    function filterSessionsByRange(sessions, range, now) {
      const start = rangeStart(range, now);
      if (!(start > 0)) return sessions;
      return sessions.filter((session) => (Number(session.createdAt) || 0) >= start);
    }


    /* ---------------- Excel export (minimal XLSX writer, no dependencies) ---------------- */

    function xmlEscapeText(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    }

    function excelColumn(index) {
      let value = index + 1;
      let name = '';
      while (value > 0) {
        const rem = (value - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        value = Math.floor((value - 1) / 26);
      }
      return name;
    }

    function excelCellXml(ref, cell) {
      const style = cell.bold === true ? ' s="1"' : '';
      if (cell.number === true) {
        const amount = Number(cell.value);
        return '<c r="' + ref + '"' + style + '><v>' + (Number.isFinite(amount) ? amount : 0) + '</v></c>';
      }
      return (
        '<c r="' +
        ref +
        '"' +
        style +
        ' t="inlineStr"><is><t xml:space="preserve">' +
        xmlEscapeText(cell.value) +
        '</t></is></c>'
      );
    }

    function buildSheetXml(rows) {
      const body = rows
        .map((row, rowIndex) => {
          const cells = row
            .map((cell, cellIndex) => excelCellXml(excelColumn(cellIndex) + (rowIndex + 1), cell))
            .join('');
          return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
        })
        .join('');
      return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/>' +
        '<col min="3" max="3" width="40" customWidth="1"/><col min="4" max="4" width="18" customWidth="1"/>' +
        '<col min="5" max="5" width="14" customWidth="1"/><col min="6" max="6" width="8" customWidth="1"/></cols>' +
        '<sheetData>' +
        body +
        '</sheetData></worksheet>'
      );
    }

    const CRC32_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
      }
      return table;
    })();

    function crc32Of(bytes) {
      let crc = 0xffffffff;
      for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    /** Minimal ZIP writer (store method) — enough for an XLSX package. */
    function zipStore(entries) {
      const encoder = new TextEncoder();
      const records = entries.map((entry) => ({ name: encoder.encode(entry.name), data: entry.data }));
      let localSize = 0;
      let centralSize = 0;
      for (const record of records) {
        localSize += 30 + record.name.length + record.data.length;
        centralSize += 46 + record.name.length;
      }
      const out = new Uint8Array(localSize + centralSize + 22);
      const view = new DataView(out.buffer);
      const offsets = [];
      const crcs = [];
      let offset = 0;
      for (const record of records) {
        const crc = crc32Of(record.data);
        offsets.push(offset);
        crcs.push(crc);
        view.setUint32(offset, 0x04034b50, true); offset += 4;
        view.setUint16(offset, 20, true); offset += 2;
        view.setUint16(offset, 0x0800, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0x21, true); offset += 2;
        view.setUint32(offset, crc, true); offset += 4;
        view.setUint32(offset, record.data.length, true); offset += 4;
        view.setUint32(offset, record.data.length, true); offset += 4;
        view.setUint16(offset, record.name.length, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        out.set(record.name, offset); offset += record.name.length;
        out.set(record.data, offset); offset += record.data.length;
      }
      const centralStart = offset;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        view.setUint32(offset, 0x02014b50, true); offset += 4;
        view.setUint16(offset, 20, true); offset += 2;
        view.setUint16(offset, 20, true); offset += 2;
        view.setUint16(offset, 0x0800, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0x21, true); offset += 2;
        view.setUint32(offset, crcs[index], true); offset += 4;
        view.setUint32(offset, record.data.length, true); offset += 4;
        view.setUint32(offset, record.data.length, true); offset += 4;
        view.setUint16(offset, record.name.length, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint32(offset, 0, true); offset += 4;
        view.setUint32(offset, offsets[index], true); offset += 4;
        out.set(record.name, offset); offset += record.name.length;
      }
      const centralBytes = offset - centralStart;
      view.setUint32(offset, 0x06054b50, true); offset += 4;
      view.setUint16(offset, 0, true); offset += 2;
      view.setUint16(offset, 0, true); offset += 2;
      view.setUint16(offset, records.length, true); offset += 2;
      view.setUint16(offset, records.length, true); offset += 2;
      view.setUint32(offset, centralBytes, true); offset += 4;
      view.setUint32(offset, centralStart, true); offset += 4;
      view.setUint16(offset, 0, true); offset += 2;
      return out;
    }

    function excelDateStamp(now) {
      const pad = (value) => String(value).padStart(2, '0');
      return (
        String(now.getFullYear()) +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        '-' +
        pad(now.getHours()) +
        pad(now.getMinutes())
      );
    }

    /** Local `YYYY-MM-DD HH:mm` for the exported session timestamp. */
    function formatSessionTime(value) {
      let time = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(time) || time <= 0) time = typeof value === 'string' ? Date.parse(value) : 0;
      if (!Number.isFinite(time) || time <= 0) return '';
      const date = new Date(time);
      const pad = (part) => String(part).padStart(2, '0');
      return (
        String(date.getFullYear()) +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      );
    }

    /**
     * Build an XLSX package for the selected billing rows.
     * `rows` = [{ kind:'group'|'session'|'total', title, groupTitle, sessionId, amountMicro, turns }]
     */
    function buildBillingWorkbook(rows, labels) {
      const encoder = new TextEncoder();
      const sheetRows = [];
      sheetRows.push(
        [
          { value: labels.group, bold: true },
          { value: labels.session, bold: true },
          { value: labels.id, bold: true },
          { value: labels.time, bold: true },
          { value: labels.amount, bold: true },
          { value: labels.turns, bold: true },
        ],
      );
      let totalMicro = 0;
      for (const row of rows) {
        const yuan = Math.round(Number(row.amountMicro) || 0) / 1000000;
        if (row.kind === 'group') {
          sheetRows.push([
            { value: row.title, bold: true },
            { value: '' },
            { value: '' },
            { value: '' },
            { value: yuan, number: true, bold: true },
            { value: '' },
          ]);
          continue;
        }
        if (row.kind === 'total') continue;
        totalMicro += Number(row.amountMicro) || 0;
        sheetRows.push([
          { value: '' },
          { value: row.title },
          { value: row.sessionId },
          { value: row.time || '' },
          { value: yuan, number: true },
          { value: Number(row.turns) || 0, number: true },
        ]);
      }
      sheetRows.push([
        { value: labels.total, bold: true },
        { value: '' },
        { value: '' },
        { value: '' },
        { value: Math.round(totalMicro) / 1000000, number: true, bold: true },
        { value: '' },
      ]);
      const sheet = buildSheetXml(sheetRows);
      const workbook =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + xmlEscapeText(labels.sheet) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
      const workbookRels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>';
      const rootRels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>';
      const styles =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
        '</styleSheet>';
      const contentTypes =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>';
      return zipStore([
        { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
        { name: '_rels/.rels', data: encoder.encode(rootRels) },
        { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
        { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
        { name: 'xl/styles.xml', data: encoder.encode(styles) },
        { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet) },
      ]);
    }

    function downloadBytes(bytes, filename) {
      if (
        typeof Blob !== 'function' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function' ||
        typeof document === 'undefined' ||
        typeof document.createElement !== 'function'
      ) {
        return false;
      }
      try {
        const blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(anchor);
        anchor.click();
        setTimeout(() => {
          if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
          if (anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
            anchor.parentNode.removeChild(anchor);
          }
        }, 0);
        return true;
      } catch {
        return false;
      }
    }

    function groupSessions(sessions, mode, sort) {
      const groups = [];
      const byKey = new Map();
      const by = sort !== undefined && sort.by === 'name' ? 'name' : 'time';
      const direction = sort !== undefined && sort.dir === 'asc' ? 1 : -1;
      const labelOf = (session) => String(session.title || session.sessionId || '');
      const timeOf = (session) => Number(session.createdAt) || 0;
      const compareSessions = (a, b) => {
        const delta = by === 'name' ? labelOf(a).localeCompare(labelOf(b), 'zh-Hans-CN') : timeOf(a) - timeOf(b);
        if (delta !== 0) return delta * direction;
        return String(a.sessionId).localeCompare(String(b.sessionId));
      };
      const groupTime = (group) => group.sessions.reduce((max, session) => Math.max(max, timeOf(session)), 0);
      const compareGroups = (a, b) => {
        const delta = by === 'name' ? a.title.localeCompare(b.title, 'zh-Hans-CN') : groupTime(a) - groupTime(b);
        if (delta !== 0) return delta * direction;
        return a.title.localeCompare(b.title, 'zh-Hans-CN');
      };
      const sorted = sessions.slice().sort(compareSessions);
      if (mode === 'flat') return [{ key: 'all', title: '', sessions: sorted }];
      for (const session of sorted) {
        const workspace = session.workspace;
        const key =
          mode === 'workspace'
            ? workspace !== null && workspace !== undefined
              ? `ws:${workspace.id}`
              : `dir:${session.cwd || ''}`
            : `dir:${session.cwd || ''}`;
        let group = byKey.get(key);
        if (group === undefined) {
          let title;
          if (mode === 'workspace' && workspace !== null && workspace !== undefined) {
            title = workspace.title || displayPath(workspace.path) || workspace.id;
          } else {
            title = session.cwd ? displayPath(session.cwd) : '';
          }
          group = { key, title, sessions: [] };
          byKey.set(key, group);
          groups.push(group);
        }
        group.sessions.push(session);
      }
      const titled = groups.filter((group) => group.title !== '').sort(compareGroups);
      const untitled = groups.filter((group) => group.title === '');
      if (untitled.length > 0) {
        titled.push({
          key: 'untitled',
          title: '',
          sessions: untitled.flatMap((group) => group.sessions),
        });
      }
      return titled;
    }

    /** The Settings page entry: 「计费明细统计」. */
    function BillingSettingsSection(props) {
      const t = (key, params) => translate(props.t, key, params);
      const [data, setData] = React.useState(undefined);
      const [error, setError] = React.useState(null);
      const [mode, setMode] = React.useState('directory');
      const [sortBy, setSortBy] = React.useState('time');
      const [sortDir, setSortDir] = React.useState('desc');
      const [collapsedKeys, setCollapsedKeys] = React.useState({});
      const [selected, setSelected] = React.useState({});
      const [notice, setNotice] = React.useState('');

      const toggleGroup = (key) =>
        setCollapsedKeys((current) => {
          const next = {};
          for (const name of Object.keys(current)) next[name] = current[name];
          if (next[key] === true) delete next[key];
          else next[key] = true;
          return next;
        });
      const [copied, setCopied] = React.useState('');
      const [thresholds, setThresholds] = React.useState(() => readThresholds());
      const [draft, setDraft] = React.useState(() => readThresholds());
      const draftTimer = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };
      const load = (force) => {
        fetchBillingState('full', force).then(
          (next) => {
            setData(next);
            setError(null);
          },
          (failure) => {
            setError(failure instanceof Error ? failure.message : String(failure));
          },
        );
      };

      React.useEffect(() => {
        load(false);
        const timer = setInterval(() => load(false), 30000);
        const onSettings = () => setThresholds(readThresholds());
        window.addEventListener(SETTINGS_EVENT, onSettings);
        return () => {
          clearInterval(timer);
          window.removeEventListener(SETTINGS_EVENT, onSettings);
          if (draftTimer.current !== null) clearTimeout(draftTimer.current);
        };
      }, []);

      const persistDraft = (next) => {
        setDraft(next);
        if (draftTimer.current !== null) clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(() => {
          const written = writeThresholds({
            cny: next.cny === '' ? null : next.cny,
            usd: next.usd === '' ? null : next.usd,
            currency: next.currency !== undefined ? next.currency : readThresholds().currency,
            showTurn: next.showTurn !== false,
            showSession: next.showSession !== false,
            showBudget: next.showBudget !== false,
            range: next.range !== undefined ? next.range : readThresholds().range,
          });
          setThresholds(written);
        }, 350);
      };

      const setDisplayFlag = (key, checked) => {
        const written = writeThresholds({ ...readThresholds(), [key]: checked });
        setThresholds(written);
        setDraft(written);
      };
      const displayToggle = (key, attr, label) =>
        h(
          'label',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              ...PAGE_TEXT,
            },
          },
          h('input', {
            type: 'checkbox',
            'data-dsh-display-toggle': attr,
            checked: thresholds[key] !== false,
            onChange: (event) => setDisplayFlag(key, event.target.checked),
            style: { accentColor: 'var(--dsw-alias-brand-primary)', margin: 0 },
          }),
          h('span', null, label),
        );

      const onCopy = (sessionId) => {
        copyTextToClipboard(sessionId).then((ok) => {
          if (!ok) return;
          setCopied(sessionId);
          setTimeout(() => setCopied((current) => (current === sessionId ? '' : current)), 1400);
        });
      };

      const account = data && data.account ? data.account : undefined;
      const wallets = account && Array.isArray(account.wallets) ? account.wallets : [];
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
      const totals = data && data.totals ? data.totals : undefined;
      const alerts = data === undefined ? [] : balanceAlerts(data, thresholds);
      const timeRange = TIME_RANGES.indexOf(thresholds.range) >= 0 ? thresholds.range : 'all';
      const visibleSessions = filterSessionsByRange(sessions, timeRange, Date.now());
      const visibleTotals = visibleSessions.reduce(
        (acc, session) => {
          acc.costMicro += amountMicroIn(session);
          acc.sessions += 1;
          return acc;
        },
        { costMicro: 0, sessions: 0 },
      );
      const groups = groupSessions(visibleSessions, mode, { by: sortBy, dir: sortDir });

      const isSelected = (sessionId) => selected[sessionId] === true;
      const toggleSessionSelection = (sessionId) =>
        setSelected((current) => {
          const next = { ...current };
          if (next[sessionId] === true) delete next[sessionId];
          else next[sessionId] = true;
          return next;
        });
      const toggleGroupSelection = (group) => {
        const ids = group.sessions.map((session) => session.sessionId);
        const all = ids.length > 0 && ids.every((id) => selected[id] === true);
        setSelected((current) => {
          const next = { ...current };
          for (const id of ids) {
            if (all) delete next[id];
            else next[id] = true;
          }
          return next;
        });
      };
      const allVisibleSelected = () =>
        visibleSessions.length > 0 && visibleSessions.every((session) => selected[session.sessionId] === true);
      const toggleSelectAll = () => {
        if (allVisibleSelected()) {
          setSelected({});
          return;
        }
        const next = {};
        for (const session of visibleSessions) next[session.sessionId] = true;
        setSelected(next);
      };
      const groupSelectionState = (group) => {
        const ids = group.sessions.map((session) => session.sessionId);
        const chosen = ids.filter((id) => selected[id] === true).length;
        return { all: ids.length > 0 && chosen === ids.length, partial: chosen > 0 && chosen < ids.length };
      };
      const exportExcel = () => {
        const rows = [];
        for (const group of groups) {
          const picked = group.sessions.filter((session) => isSelected(session.sessionId));
          if (picked.length === 0) continue;
          const groupTitle = group.title || t('unknownDir');
          const groupMicro = picked.reduce((sum, session) => sum + amountMicroIn(session), 0);
          if (mode !== 'flat') rows.push({ kind: 'group', title: groupTitle, amountMicro: groupMicro });
          for (const session of picked) {
            rows.push({
              kind: 'session',
              groupTitle,
              title: session.title || session.sessionId,
              sessionId: session.sessionId,
              time: formatSessionTime(session.createdAt),
              amountMicro: amountMicroIn(session),
              turns: session.turns,
            });
          }
        }
        if (rows.length === 0) {
          setNotice(t('exportEmpty'));
          return;
        }
        const labels = {
          group: t('exportColGroup'),
          session: t('exportColSession'),
          id: t('exportColId'),
          time: t('exportColTime'),
          amount: t('exportColAmount', { currency: currencyName() }),
          turns: t('exportColTurns'),
          total: t('exportTotal'),
          sheet: t('exportSheet'),
        };
        const bytes = buildBillingWorkbook(rows, labels);
        if (!downloadBytes(bytes, '计费明细-' + excelDateStamp(new Date()) + '.xlsx')) {
          setNotice(t('exportFailed'));
        }
      };

      const MODE_OPTIONS = [
        ['directory', 'modeDirectory'],
        ['workspace', 'modeWorkspace'],
        ['flat', 'modeFlat'],
      ];
      const SORT_OPTIONS = [
        ['time', 'desc'],
        ['time', 'asc'],
        ['name', 'asc'],
        ['name', 'desc'],
      ];
      const RANGE_OPTION_KEYS = {
        today: 'rangeToday',
        '7d': 'range7d',
        '30d': 'range30d',
        '90d': 'range90d',
        '180d': 'range180d',
        '365d': 'range365d',
        all: 'rangeAll',
      };

      const selectStyle = {
        ...SMALL_BUTTON,
        height: 'auto',
        minHeight: 30,
        padding: '6px 28px 6px 10px',
        lineHeight: 1.4,
        minWidth: 150,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      };

      const CONTROL_LABEL_WIDTH = 72;
      const controlRow = (label, control) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { ...HINT, flex: '0 0 ' + CONTROL_LABEL_WIDTH + 'px', width: CONTROL_LABEL_WIDTH } }, label),
          control,
        );

      const currentCurrency =
        thresholds.currency === 'USD' || thresholds.currency === 'CNY' ? thresholds.currency : defaultCurrency();
      const currencySelect = () =>
        h(
          'select',
          {
            'data-dsh-currency-select': currentCurrency,
            value: currentCurrency,
            'aria-label': t('currencyLabel'),
            onChange: (event) => {
              const picked = event && event.target ? event.target.value : currentCurrency;
              const written = writeThresholds({ ...readThresholds(), currency: picked });
              setThresholds(written);
              setDraft(written);
            },
            style: selectStyle,
          },
          [
            ['CNY', 'currencyCny'],
            ['USD', 'currencyUsd'],
          ].map(([value, key]) =>
            h('option', { key: value, value, selected: currentCurrency === value }, t(key)),
          ),
        );

      const modeSelect = () =>
        h(
          'select',
          {
            'data-dsh-billing-mode': mode,
            value: mode,
            'aria-label': t('sessionsTitle'),
            onChange: (event) => setMode(event.target.value),
            style: selectStyle,
          },
          MODE_OPTIONS.map(([id, key]) => h('option', { key: id, value: id, selected: mode === id }, t(key))),
        );

      const sortSelect = () => {
        const value = `${sortBy}:${sortDir}`;
        return h(
          'select',
          {
            'data-dsh-sort-select': value,
            value,
            'aria-label': t('sortLabel'),
            onChange: (event) => {
              const [by, dir] = String(event.target.value).split(':');
              setSortBy(by === 'name' ? 'name' : 'time');
              setSortDir(dir === 'asc' ? 'asc' : 'desc');
            },
            style: selectStyle,
          },
          SORT_OPTIONS.map(([by, dir]) => {
            const label = by === 'name' ? t('sortName') : t('sortTime');
            const arrow = dir === 'asc' ? t('sortAsc') : t('sortDesc');
            return h(
              'option',
              { key: `${by}:${dir}`, value: `${by}:${dir}`, selected: by === sortBy && dir === sortDir },
              `${label}${t('sortJoin')}${arrow}`,
            );
          }),
        );
      };

      const rangeSelect = () =>
        h(
          'select',
          {
            'data-dsh-time-range': timeRange,
            value: timeRange,
            'aria-label': t('rangeLabel'),
            onChange: (event) => {
              const written = writeThresholds({ ...readThresholds(), range: event.target.value });
              setThresholds(written);
              setDraft(written);
            },
            style: selectStyle,
          },
          TIME_RANGES.map((id) =>
            h('option', { key: id, value: id, selected: timeRange === id }, t(RANGE_OPTION_KEYS[id] || id)),
          ),
        );

      const activeCur = activeCurrency();
      const convertWallet = (wallet, value) => {
        const converted = wallet.currency !== activeCur;
        const shown = converted ? convertAmount(value, wallet.currency, activeCur) : Number(value);
        return `${converted ? '≈' : ''}${formatAmount(activeCur, shown)}`;
      };
      const balanceLine = (wallet) => {
        const threshold = thresholdFor(thresholds, wallet.currency);
        const below = threshold !== null && Number(wallet.recharge) <= threshold;
        return h(
          'div',
          {
            key: wallet.currency,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '2px 0',
              ...PAGE_TEXT,
            },
          },
          h(
            'span',
            { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            currencyName(activeCur),
          ),
          h('span', null, `${t('balanceRecharge')} ${convertWallet(wallet, wallet.recharge)}`),
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, `${t('balanceBonus')} ${convertWallet(wallet, wallet.bonus)}`),
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, `${t('balanceTotal')} ${convertWallet(wallet, wallet.total)}`),
          threshold === null
            ? null
            : h(
                'span',
                {
                  'data-dsh-threshold-state': below ? 'below' : 'above',
                  style: {
                    color: below ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)',
                  },
                },
                below ? t('thresholdHit') : t('thresholdOk'),
              ),
        );
      };

      return h(
        'div',
        {
          'data-dsh-billing-page': 'true',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: '4px 0 24px',
            maxWidth: 760,
          },
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('h2', { style: { ...CARD_TITLE, fontSize: 'calc(16px + var(--dsh-content-font-delta, 0px))' } }, t('sectionTitle')),
          h('p', { style: HINT }, t('sectionDesc')),
        ),

        // Card 1: balance reminder.
        h(
          'section',
          { style: CARD, 'data-dsh-billing-card': 'reminder' },
          h('h3', { style: CARD_TITLE }, t('balanceTitle')),
          h('p', { style: HINT }, t('balanceDesc')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...PAGE_TEXT } },
            h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('thresholdCny')),
            h('input', {
              type: 'number',
              min: 0,
              step: '0.01',
              inputMode: 'decimal',
              placeholder: '—',
              'data-dsh-threshold': 'cny',
              value: draft.cny === null || draft.cny === undefined ? '' : String(draft.cny),
              onChange: (event) => persistDraft({ ...draft, cny: event.target.value }),
              style: INPUT,
            }),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('thresholdSuffix')),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...PAGE_TEXT } },
            h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('thresholdUsd')),
            h('input', {
              type: 'number',
              min: 0,
              step: '0.01',
              inputMode: 'decimal',
              placeholder: '—',
              'data-dsh-threshold': 'usd',
              value: draft.usd === null || draft.usd === undefined ? '' : String(draft.usd),
              onChange: (event) => persistDraft({ ...draft, usd: event.target.value }),
              style: INPUT,
            }),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('thresholdSuffix')),
          ),
          h('p', { style: HINT }, t('balanceHint')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, t('balanceCurrent'), wallets.length === 0 ? null : wallets.map(balanceLine)),
          wallets.some((wallet) => wallet.currency !== activeCurrency())
            ? h(
                'p',
                { 'data-dsh-fx-note': 'true', style: { ...HINT, color: 'var(--dsw-alias-label-tertiary)' } },
                t('currencyNote'),
              )
            : null,
          wallets.length === 0
            ? h(
                'p',
                { style: { ...HINT, color: 'var(--dsw-alias-label-tertiary)' } },
                account && account.status === 'signed-out' ? t('balanceSignedOut') : t('balanceUnavailable'),
              )
            : null,
          alerts.length > 0
            ? h(
                'p',
                {
                  style: {
                    ...PAGE_TEXT,
                    color: 'var(--dsw-alias-state-warn-primary)',
                  },
                },
                t('reminderActive'),
              )
            : null,
        ),

        // Card 2: footer display toggles.
        h(
          'section',
          { style: CARD, 'data-dsh-billing-card': 'display' },
          h('h3', { style: CARD_TITLE }, t('displayTitle')),
          h('p', { style: HINT }, t('displayDesc')),
          displayToggle('showTurn', 'turn', t('displayTurn')),
          displayToggle('showSession', 'session', t('displaySession')),
          displayToggle('showBudget', 'budget', t('displayBudget')),
        ),

        // Card 3: session billing statistics.
        h(
          'section',
          { style: CARD, 'data-dsh-billing-card': 'sessions' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: { ...CARD_TITLE, marginRight: 'auto' } }, t('sessionsTitle')),
            h('button', { type: 'button', style: SMALL_BUTTON, onClick: () => load(true) }, t('refresh')),
          ),
          h('p', { style: HINT }, t('sessionsDesc', { count: visibleSessions.length })),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            controlRow(t('currencyLabel'), currencySelect()),
            controlRow(t('groupLabel'), modeSelect()),
            controlRow(t('sortLabel'), sortSelect()),
            controlRow(t('rangeLabel'), rangeSelect()),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' } },
            totals === undefined
              ? h('p', { style: HINT }, t('loading'))
              : h(
                  'p',
                  { style: { ...PAGE_TEXT, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                  t('totalLine', { amount: moneyMicro(visibleTotals.costMicro), count: visibleTotals.sessions }),
                ),
            totals === undefined
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-dsh-select-all': 'true',
                      'aria-pressed': allVisibleSelected() ? 'true' : 'false',
                      onClick: toggleSelectAll,
                      style: { ...SMALL_BUTTON },
                    },
                    t(allVisibleSelected() ? 'selectNone' : 'selectAll'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-dsh-billing-export': 'true',
                      onClick: exportExcel,
                      style: { ...SMALL_BUTTON },
                    },
                    t('exportExcel'),
                  ),
                ),
          ),
          error !== null
            ? h('p', { style: { ...HINT, color: 'var(--dsw-alias-state-error-primary)' } }, t('errorLoad', { message: error }))
            : null,
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                maxHeight: 380,
                overflowY: 'auto',
                paddingRight: 4,
              },
            },
            visibleSessions.length === 0 && data !== undefined
              ? h('p', { style: HINT }, sessions.length > 0 ? t('emptyRange') : t('empty'))
              : groups.map((group) => {
                  const selection = groupSelectionState(group);
                  return h(
                    'div',
                    { key: group.key, style: { display: 'flex', flexDirection: 'column' } },
                    group.title === ''
                      ? null
                      : h(
                          'div',
                          {
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 0 2px',
                              borderTop: '1px solid var(--dsw-alias-border-l1)',
                            },
                          },
                          h('input', {
                            type: 'checkbox',
                            'data-dsh-billing-select': 'group',
                            'data-dsh-group-key': group.key,
                            checked: selection.all,
                            ref: (element) => {
                              if (element && typeof element === 'object') {
                                element.indeterminate = selection.partial && !selection.all;
                              }
                            },
                            'aria-label': t('selectGroup', { name: group.title }),
                            onChange: () => toggleGroupSelection(group),
                            style: {
                              flex: '0 0 auto',
                              margin: 0,
                              width: 14,
                              height: 14,
                              cursor: 'pointer',
                              accentColor: 'var(--dsw-alias-brand-primary)',
                            },
                          }),
                          mode === 'directory' || mode === 'workspace'
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  'data-dsh-group-toggle': group.key,
                                  'aria-expanded': collapsedKeys[group.key] === true ? 'false' : 'true',
                                  'aria-label': t(collapsedKeys[group.key] === true ? 'groupExpand' : 'groupCollapse', {
                                    name: group.title,
                                  }),
                                  onClick: () => toggleGroup(group.key),
                                  style: {
                                    flex: '0 0 20px',
                                    width: 20,
                                    height: 20,
                                    padding: 0,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    border: 'none',
                                    background: 'transparent',
                                    color: 'var(--dsw-alias-label-secondary)',
                                    cursor: 'pointer',
                                    lineHeight: 1,
                                  },
                                },
                                h(
                                  'svg',
                                  {
                                    width: 16,
                                    height: 16,
                                    viewBox: '0 0 16 16',
                                    fill: 'none',
                                    stroke: 'currentColor',
                                    strokeWidth: 1.8,
                                    strokeLinecap: 'round',
                                    strokeLinejoin: 'round',
                                    'aria-hidden': 'true',
                                    'data-dsh-group-chevron': collapsedKeys[group.key] === true ? 'right' : 'down',
                                    style: {
                                      transform: collapsedKeys[group.key] === true ? 'rotate(-90deg)' : 'none',
                                      transition: 'transform 120ms ease',
                                    },
                                  },
                                  h('path', { d: 'M4 6.2 8 10.2 12 6.2' }),
                                ),
                              )
                            : null,
                          h(
                            'span',
                            {
                              style: {
                                ...PAGE_TEXT,
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                fontWeight: 600,
                                color: 'var(--dsw-alias-label-primary)',
                              },
                              title: group.title,
                            },
                            mode === 'directory'
                              ? group.title === ''
                                ? t('unknownDir')
                                : group.title
                              : group.title,
                          ),
                          h(
                            'span',
                            { style: { ...MUTED, color: 'var(--dsw-alias-label-secondary)' } },
                            moneyMicro(group.sessions.reduce((sum, session) => sum + amountMicroIn(session), 0)),
                          ),
                        ),
                    ...(collapsedKeys[group.key] === true
                      ? []
                      : group.sessions.map((session) =>
                          h(SessionRow, {
                            key: session.sessionId,
                            t,
                            session,
                            copied,
                            onCopy,
                            selectable: true,
                            selected: isSelected(session.sessionId),
                            onToggle: toggleSessionSelection,
                          }),
                        )),
                  );
                }),
          ),
        ),

        // 「当前没有选中」 notice (export with an empty selection).
        notice === ''
          ? null
          : h(
              'div',
              {
                'data-dsh-billing-notice-backdrop': 'true',
                onClick: () => setNotice(''),
                style: { ...BACKDROP, zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center' },
              },
              h(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'data-dsh-billing-notice': 'true',
                  onClick: (event) => event.stopPropagation(),
                  style: { ...PANEL, position: 'relative', zIndex: 1301, minWidth: 'min(320px, calc(100vw - 48px))' },
                },
                h('div', { style: PANEL_TITLE }, h('span', null, t('exportExcel'))),
                h('div', { style: PANEL_RULE }),
                h('div', { style: { ...PANEL_BODY, minWidth: 220 } }, h('span', null, notice)),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-dsh-billing-notice-close': 'true',
                      onClick: () => setNotice(''),
                      style: { ...SMALL_BUTTON, padding: '6px 12px' },
                    },
                    t('exportClose'),
                  ),
                ),
              ),
            ),
      );
    }

    /** Settings navigation icon for 「计费明细统计」. */
    function BillingSectionIcon(props) {
      const size = Number(props.size) || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { color: props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M9 7.5l3 4 3-4' }),
        h('path', { d: 'M12 11.5v6' }),
        h('path', { d: 'M9 13.5h6' }),
        h('path', { d: 'M9 16h6' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Composer budget: a 「预算 ¥20」 trigger in the composer dock.
     *
     * The amount is per Session and kept in localStorage; the trigger text and
     * the over-budget reminder are driven by the `turnCost` projection (falling
     * back to the local store), so no Host round-trip is needed. Reaching the
     * budget only warns — it never blocks the next turn.
     * ------------------------------------------------------------------ */

    const BUDGET_KEY = 'dsh.turn-cost.budget.v1';
    const BUDGET_EVENT = 'dsh-turn-cost:budget';

    /**
     * Per-session budgets persisted as
     * `{v:2, budgets:{<sessionId>:{micro, currency}}}`; v1 values were a bare
     * micro-CNY number and are migrated on read. Keeping the currency means a
     * budget set in the Chinese UI stays a CNY budget after switching to English.
     */
    function readBudgets() {
      const budgets = {};
      try {
        if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return budgets;
        const raw = localStorage.getItem(BUDGET_KEY);
        if (!raw) return budgets;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return budgets;
        if (!parsed.budgets || typeof parsed.budgets !== 'object') return budgets;
        for (const key of Object.keys(parsed.budgets)) {
          const record = parsed.budgets[key];
          if (typeof record === 'number') {
            const micro = Number(record);
            if (Number.isFinite(micro) && micro > 0) budgets[key] = { micro, currency: 'CNY' };
            continue;
          }
          if (!record || typeof record !== 'object') continue;
          const micro = Number(record.micro);
          const currency = record.currency === 'USD' ? 'USD' : record.currency === 'CNY' ? 'CNY' : undefined;
          if (currency !== undefined && Number.isFinite(micro) && micro > 0) budgets[key] = { micro, currency };
        }
      } catch {
        /* private mode or malformed value: no budgets */
      }
      return budgets;
    }

    function readBudget(sessionId) {
      if (!sessionId) return undefined;
      return readBudgets()[sessionId];
    }

    /** Persist one Session's budget; null clears it. */
    function writeBudget(sessionId, micro, currency) {
      if (!sessionId) return;
      const budgets = readBudgets();
      if (micro === null) delete budgets[sessionId];
      else budgets[sessionId] = { micro, currency: currency === 'USD' ? 'USD' : 'CNY' };
      try {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
          localStorage.setItem(BUDGET_KEY, JSON.stringify({ v: 2, budgets }));
        }
      } catch {
        /* quota or private mode: the click still re-renders */
      }
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(BUDGET_EVENT));
        }
      } catch {
        /* no CustomEvent in this environment */
      }
    }

    /** Sum of one Session's per-turn amounts in `currency` (micro units). */
    function sumEntriesMicro(entries, currency, upToTurn) {
      let total = 0;
      let counted = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') continue;
        if (upToTurn !== undefined && Number(entry.turn) > upToTurn) continue;
        const micro = entryMicro(entry, currency);
        if (micro === null) continue;
        total += micro;
        counted += 1;
      }
      return { total, counted };
    }

    /** A projection/store record's Session total in `currency` (micro units). */
    function viewTotalMicro(view, currency) {
      if (!view || typeof view !== 'object') return undefined;
      if (Array.isArray(view.turns)) return sumEntriesMicro(view.turns, currency).total;
      if (view.turns && typeof view.turns === 'object') return sumEntriesMicro(Object.values(view.turns), currency).total;
      const session = view.session;
      if (session && currency === 'CNY') {
        const fromSession = Number(session.costMicro);
        if (Number.isFinite(fromSession) && fromSession >= 0) return fromSession;
      }
      return undefined;
    }

    /** This Session's total cost in `currency` (micro units): projection then store. */
    function sessionCostMicro(props, sessionId, currency) {
      const target = currency || activeCurrency();
      const projection = readProjection(props);
      const fromProjection = projection === undefined ? undefined : viewTotalMicro(projection, target);
      if (fromProjection !== undefined) return fromProjection;
      if (!sessionId) return undefined;
      const record = turnCostStore().getSession(sessionId);
      return viewTotalMicro(record, target);
    }

    /**
     * Budget pill below the composer. Click opens 「设置预算」 in the same
     * anchored popover style as the footer dialogs; the label always shows the
     * current budget and turns warning-colored once the Session reaches it.
     */
    /** Account-level pills above the composer: 「预算」 and 「剩余」, both always visible. */
    function ComposerCostEntry(props) {
      const t = (key, params) => translate(props.t, key, params);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const [, forceRender] = React.useState(0);
      const [panel, setPanel] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [hovered, setHovered] = React.useState(null);
      const [error, setError] = React.useState('');
      const [settings, setSettings] = React.useState(() => readDisplaySettings());
      const [account, setAccount] = React.useState(() => balanceState.account);

      // The composer tool row gets cramped on narrow layouts; the pill then
      // collapses to the currency symbol only. Measured against the nearest
      // positioned ancestor (the composer card) so it follows real layout
      // rather than the viewport alone.
      const [compactLabel, setCompactLabel] = React.useState(false);
      const rootRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };

      React.useEffect(() => {
        const sync = () => forceRender((value) => value + 1);
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
        window.addEventListener(BUDGET_EVENT, sync);
        return () => window.removeEventListener(BUDGET_EVENT, sync);
      }, []);


      React.useEffect(() => {
        const offDisplay = subscribeDisplaySettings((next) => setSettings(next));
        const offBalance = subscribeBalance((next) => setAccount(next));
        refreshDisplaySettings();
        refreshBalance(false);
        return () => {
          offDisplay();
          offBalance();
        };
      }, []);

      React.useEffect(() => {
        if (settings.showBudget === false && panel !== null) setPanel(null);
      }, [settings.showBudget]);

      React.useEffect(() => {
        if (panel === null) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined;
        }
        const onKey = (event) => {
          if (event && event.key === 'Escape') setPanel(null);
        };
        document.addEventListener('keydown', onKey);
        return () => {
          if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKey);
          }
        };
      }, [panel]);

      React.useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const measure = () => {
          const root = rootRef.current;
          // The composer's tool row is the app's own CSS container
          // (`.JZLxKW_row{container-type:inline-size}`); its width equals the
          // composer's usable width and does NOT depend on this pill's label
          // (so it cannot feed back into the measurement) -- unlike the row's
          // content width, which oscillated with the model selector. 560px is
          // the app's own compact breakpoint for that row. Fall back to the
          // nearest `position: relative` ancestor (the composer card) and
          // finally to the viewport.
          let width = 0;
          let node = root && root.parentElement;
          let guard = 0;
          while (node && guard < 12) {
            const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : undefined;
            if (style) {
              const isContainer = style.containerType === 'inline-size';
              if (isContainer || style.position === 'relative') {
                const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : undefined;
                const candidate = Number(rect && rect.width) || 0;
                if (candidate > 0) {
                  width = candidate;
                  break;
                }
              }
            }
            node = node.parentElement;
            guard += 1;
          }
          const viewport = Number(window.innerWidth) || 0;
          const rowWidth = width >= 300 ? width : 0;
          const compactByRow = rowWidth > 0 && rowWidth <= 560;
          // No measurable row: a narrow viewport implies a narrow composer.
          const compactByViewport = !(rowWidth > 0) && viewport > 0 && viewport < 900;
          setCompactLabel(compactByRow || compactByViewport);
        };
        measure();
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', measure);
        const timer = typeof window.setInterval === 'function' ? window.setInterval(measure, 1000) : undefined;
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure);
          if (timer !== undefined && typeof window.clearInterval === 'function') window.clearInterval(timer);
        };
      }, []);

      const displayCurrency = activeCurrency();
      const budget = readBudget(sessionId);
      // The 币种 setting drives every amount on screen. A budget set while the
      // other currency was active is converted for display (approx, labelled),
      // and saved back in the active currency when the user edits it.
      const budgetConverted = budget !== undefined && budget.currency !== displayCurrency;
      const budgetMicro =
        budget === undefined
          ? undefined
          : budgetConverted
            ? Math.round(approxConvertMicro(budget.micro, budget.currency, displayCurrency))
            : budget.micro;
      const budgetText =
        budgetMicro === undefined
          ? undefined
          : `${budgetConverted ? '≈' : ''}${money(budgetMicro / 1e6, displayCurrency)}`;
      const costMicro = sessionCostMicro(props, sessionId, displayCurrency);
      const exceeded =
        budget !== undefined && costMicro !== undefined && budgetMicro !== undefined && costMicro >= budgetMicro;
      const remaining = remainingSummary(account);
      const showBalance = remaining !== undefined;
      // The 显示项 toggle used to hide the balance block; since 0.5.7 it
      // controls the whole 「预算」 pill instead (default on).
      const showBudget = settings.showBudget !== false;
      // Symbol first: 「¥ 预算 18」 / 「$ Budget 18」; on a cramped composer the
      // pill keeps only the symbol. Over-budget is signalled by the orange
      // label colour (no icon).
      const budgetSymbol = symbolFor(displayCurrency);
      const budgetLabel = compactLabel
        ? budgetSymbol
        : budget === undefined
          ? t('budgetUnset')
          : `${budgetSymbol} ${t('budgetWord')} ${budgetConverted ? '≈' : ''}${moneyAmount(budgetMicro / 1e6)}`;

      const budgetLines = [];
      if (costMicro !== undefined) budgetLines.push(`${t('budgetUsed')}：${money(costMicro / 1e6, displayCurrency)}`);
      budgetLines.push(`${t('budgetCurrent')}：${budget === undefined ? t('budgetUnsetHint') : budgetText}`);
      if (budgetConverted) budgetLines.push(t('currencyNote'));


      const close = () => {
        setPanel(null);
        setError('');
      };
      const openBudget = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        if (panel !== null) {
          close();
          return;
        }
        if (budgetMicro === undefined) setDraft('');
        else setDraft(String(Math.round((budgetMicro / 1e6) * 100) / 100));
        setError('');
        // Read geometry eagerly: React nulls `event.currentTarget` before a
        // deferred state updater runs. Composer panels always open upwards,
        // right-aligned to the 预算 pill.
        const pos = panelPosition(event, [...budgetLines, '', '', ''], 'above');
        setPanel({ pos });
      };
      const save = () => {
        const value = Number(String(draft).replace(',', '.'));
        if (!Number.isFinite(value) || value <= 0) {
          setError(t('budgetInvalid'));
          return;
        }
        writeBudget(sessionId, Math.round(value * 1e6), activeCurrency());
        close();
      };
      const clear = () => {
        writeBudget(sessionId, null);
        close();
      };

      const pillStyle = (kind) => ({
        ...MUTED,
        height: 'calc(26px + var(--dsh-content-font-delta, 0px))',
        padding: '0 8px',
        borderRadius: 8,
        border: 'none',
        background:
          hovered === kind || panel !== null
            ? 'var(--dsw-alias-interactive-bg-hover)'
            : 'transparent',
        color: exceeded ? 'var(--dsw-alias-state-warn-primary)' : MUTED.color,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'inherit',
        cursor: 'pointer',
      });

      const heading = (line) => {
        const colon = line.indexOf('：');
        return colon > 0
          ? h(
              'div',
              { key: line, style: PANEL_ROW },
              h('span', { style: PANEL_ROW_LABEL }, line.slice(0, colon)),
              h('span', { style: PANEL_ROW_VALUE }, line.slice(colon + 1)),
            )
          : null;
      };
      const rowsOf = (lines) =>
        lines.map((line, index) => {
          if (line === '') return h('div', { key: `gap-${index}`, style: { height: 8 } });
          return (
            heading(line) ||
            h('div', { key: `note-${index}`, style: PANEL_ROW }, line)
          );
        });

      const anchor = panel && panel.pos ? panel.pos : { right: 24, bottom: 72 };
      const panelTitle = t('budgetTitle');
      const panelValue = costMicro === undefined ? '' : money(costMicro / 1e6, displayCurrency);

      // Account balance / bonus / total live in the same dialog (0.5.6 merged
      // the former 剩余 pill into it); the 「显示项」 toggle still hides this
      // section when the user turns it off.
      const balanceRows = [];
      if (showBalance) {
        const converted = remaining.items.some((item) => item.currency !== displayCurrency);
        const showWallet = (item, value) => {
          const approx = item.currency !== displayCurrency;
          const shown = approx ? convertAmount(value, item.currency, displayCurrency) : Number(value);
          return `${approx ? '≈' : ''}${formatAmount(displayCurrency, shown)}`;
        };
        for (const item of remaining.items) {
          balanceRows.push(
            h(
              'div',
              { key: `bal-${item.currency}`, style: { ...PANEL_SECTION, marginTop: 12 } },
              t('remainingTitle'),
            ),
            ...rowsOf([
              `${t('remainingBalance')}（${currencyName(displayCurrency)}）：${showWallet(item, item.recharge)}`,
              `${t('remainingBonus')}（${currencyName(displayCurrency)}）：${showWallet(item, item.bonus)}`,
              `${t('remainingTotal')}（${currencyName(displayCurrency)}）：${showWallet(item, item.total)}`,
            ]),
          );
        }
        if (converted) balanceRows.push(h('div', { key: 'fx-note', style: PANEL_NOTE }, t('currencyNote')));
      }

      const panelBody = [
            ...rowsOf(budgetLines),
            exceeded
              ? h(
                  'div',
                  {
                    key: 'warn',
                    'data-dsh-budget-panel-warning': 'true',
                    style: { ...PANEL_NOTE, color: 'var(--dsw-alias-state-warn-primary)' },
                  },
                  t('budgetExceeded'),
                )
              : null,
            h(
              'div',
              { key: 'amount', style: { ...PANEL_ROW, marginTop: 10 } },
              h('span', { style: PANEL_ROW_LABEL }, t('budgetAmount', { currency: currencyName(displayCurrency) })),
              h('input', {
                type: 'number',
                min: '0',
                step: '0.01',
                inputMode: 'decimal',
                value: draft,
                placeholder: t('budgetPlaceholder'),
                'data-dsh-budget-input': 'true',
                onChange: (event) => setDraft(event && event.target ? event.target.value : ''),
                onKeyDown: (event) => {
                  if (event && event.key === 'Enter') {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    save();
                  }
                },
                style: { ...INPUT, width: 120, marginLeft: 'auto' },
              }),
            ),
            error
              ? h(
                  'div',
                  {
                    key: 'error',
                    'data-dsh-budget-error': 'true',
                    style: { ...PANEL_NOTE, color: 'var(--dsw-alias-state-error-primary)' },
                  },
                  error,
                )
              : null,
            ...balanceRows,
            h('div', { key: 'hint', style: { ...PANEL_NOTE } }, t('budgetHint')),
          ];

      const panelFooter = h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } },
            h(
              'button',
              {
                type: 'button',
                'data-dsh-budget-clear': 'true',
                onClick: clear,
                disabled: budget === undefined,
                style: SMALL_BUTTON,
              },
              t('budgetClear'),
            ),
            h('button', { type: 'button', 'data-dsh-budget-cancel': 'true', onClick: close, style: SMALL_BUTTON }, t('budgetCancel')),
            h(
              'button',
              {
                type: 'button',
                'data-dsh-budget-save': 'true',
                onClick: save,
                style: {
                  ...SMALL_BUTTON,
                  borderColor: 'var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontWeight: 600,
                },
              },
              t('budgetSave'),
            ),
          );

      if (!showBudget) return null;

      return h(
        'div',
        {
          'data-dsh-composer-cost': 'true',
          ref: rootRef,
          // Rendered in `conversation.input.right`, the compact controls just
          // before the model selector in the composer tool row.
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            flex: '0 0 auto',
            minWidth: 0,
            // The shipped `standardControls` row uses a 12px gap; a -6px
            // margin here halves the visual distance to the model selector
            // (1.0.5) without touching the shipped stylesheet.
            marginRight: '-6px',
          },
        },
        h(
          'button',
          {
            type: 'button',
            'data-dsh-budget-toggle': 'true',
            'aria-haspopup': 'dialog',
            'aria-expanded': panel !== null ? 'true' : 'false',
            'aria-label': t('budgetTitle'),
            onClick: openBudget,
            onMouseEnter: () => setHovered('budget'),
            onMouseLeave: () => setHovered(null),
            style: pillStyle('budget'),
          },
          h('span', { 'data-dsh-budget-label': 'true' }, budgetLabel),
        ),
        panel !== null
          ? h('div', {
              key: 'backdrop',
              'data-dsh-budget-backdrop': 'true',
              onClick: close,
              style: BACKDROP,
            })
          : null,
        panel !== null
          ? h(
              'div',
              {
                key: 'panel',
                role: 'dialog',
                'aria-label': panelTitle,
                'data-dsh-budget-panel': 'true',
                style: {
                  ...PANEL,
                  position: 'fixed',
                  ...(anchor.top !== undefined ? { top: anchor.top } : { bottom: anchor.bottom }),
                  ...(anchor.left !== undefined ? { left: anchor.left } : { right: anchor.right }),
                },
              },
              h(
                'div',
                { style: PANEL_TITLE },
                h('span', { style: PANEL_ICON }, costPanelIcon(), h('span', null, panelTitle)),
                h('span', { style: PANEL_VALUE }, panelValue),
              ),
              h('div', { style: PANEL_RULE, 'aria-hidden': true }),
              h(
                'div',
                { style: PANEL_BODY },
                ...panelBody.filter(Boolean),
              ),
              panelFooter,
            )
          : null,
      );
    }


    /**
     * Invisible anchor kept at the old pill spot above the composer card. It
     * publishes the card's right edge so the turn footer keeps its alignment
     * with where the 预算 pill used to sit; the visible pill now lives in the
     * composer tool row (`conversation.input.right`).
     */
    function ComposerAnchor() {
      const nodeRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };
      React.useEffect(() => {
        const publish = () => {
          const node = nodeRef.current;
          if (!node || typeof node.getBoundingClientRect !== 'function') return;
          try {
            publishComposerRight(node.getBoundingClientRect().right);
          } catch {
            publishComposerRight(null);
          }
        };
        publish();
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
          return () => publishComposerRight(null);
        }
        window.addEventListener('resize', publish);
        const timer = typeof setInterval === 'function' ? setInterval(publish, 1000) : undefined;
        return () => {
          window.removeEventListener('resize', publish);
          if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer);
          publishComposerRight(null);
        };
      }, []);
      return h('div', {
        'data-dsh-composer-anchor': 'true',
        'aria-hidden': 'true',
        ref: nodeRef,
        style: {
          position: 'absolute',
          right: 60,
          top: -34,
          width: 0,
          height: 0,
          pointerEvents: 'none',
        },
      });
    }

    return {
      inject: ['slots', 'locale'],
      /** Reusable record for other features (also at globalThis.__DSH_TURN_COST_STORE__). */
      store: {
        create: createTurnCostStore,
        current: turnCostStore,
        key: STORE_KEY,
        version: STORE_VERSION,
      },
      /** Dependency-free XLSX writer used by the billing export (unit-testable). */
      excel: {
        buildWorkbook: buildBillingWorkbook,
        dateStamp: excelDateStamp,
        fileName: (now) => '计费明细-' + excelDateStamp(now instanceof Date ? now : new Date()) + '.xlsx',
      },
      /** Settings persistence (display toggles + thresholds + 币种) for other surfaces. */
      settings: {
        read: readThresholds,
        write: writeThresholds,
        refresh: () => refreshDisplaySettings(),
      },
      /** Currency layer: driven by the settings 币种 selector (default: UI language). */
      currency: {
        active: activeCurrency,
        symbol: symbolFor,
        prices: priceTable,
        webRequestPrice,
        set: (value) => writeThresholds({ ...readThresholds(), currency: value === 'USD' ? 'USD' : 'CNY' }),
      },
      apply(ctx) {
        // Amounts follow the UI language; capture the locale face first.
        try {
          localeFace = ctx.locale;
        } catch {
          localeFace = undefined;
        }
        ctx.effect(() => ctx.locale.register('turn-cost', 'zh', DICTIONARIES.zh));
        ctx.effect(() => ctx.locale.register('turn-cost', 'en', DICTIONARIES.en));
        // Live-apply 「显示项」 changes made in the settings page to open footers.
        try {
          ctx.effect(() => {
            if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
              return () => {};
            }
            const sync = () => refreshDisplaySettings();
            window.addEventListener(SETTINGS_EVENT, sync);
            return () => window.removeEventListener(SETTINGS_EVENT, sync);
          }, 'turn-cost: display settings sync');
        } catch (error) {
          console.error('[turn-cost] display settings listener failed:', error);
        }

        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'turn-cost',
              order: 30,
              locale: 'turn-cost',
            },
            TurnCostBadge,
          ),
        );

        // Settings page (own section, right below 「账号与余额」) + its nav icon.
        const label =
          typeof ctx.locale.bind === 'function' ? ctx.locale.bind('turn-cost') : (key) => DICTIONARIES.zh[key] || key;
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'turn-cost-billing',
                order: -5,
                locale: 'turn-cost',
                label: () => label('sectionLabel'),
              },
              BillingSettingsSection,
            ),
          );
        } catch (error) {
          console.error('[turn-cost] settings section registration failed', error);
        }

        // The section icon slot only exists from DSH 0.2.2-alpha.3 on. Keep the
        // page usable on older builds by skipping the icon silently.
        try {
          ctx.slots.inject('settings.section.icon', () =>
            ctx.slots.register(
              { name: 'settings.section.icon', id: 'turn-cost-billing', order: -5 },
              BillingSectionIcon,
            ),
          );
        } catch (error) {
          if (typeof console.debug === 'function') {
            console.debug('[turn-cost] settings section icon slot unavailable', error);
          }
        }

        // Frame-wide reminder card (the layer is click-through; we opt back in).
        try {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'turn-cost.balance-reminder', order: 900, locale: 'turn-cost' },
              BalanceReminder,
            ),
          );
        } catch (error) {
          console.error('[turn-cost] balance reminder registration failed', error);
        }

        // 「预算」 pill in the composer tool row, immediately left of the model
        // selector (session-scoped, so it appears once the Session exists).
        try {
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: 'turn-cost-composer',
                order: 5,
                locale: 'turn-cost',
              },
              ComposerCostEntry,
            ),
          );
        } catch (error) {
          console.error('[turn-cost] composer cost registration failed', error);
        }

        // Invisible anchor at the old above-card spot: publishes the composer
        // right edge for the turn footer alignment.
        try {
          ctx.slots.inject('conversation.input.overlay', () =>
            ctx.slots.register(
              { name: 'conversation.input.overlay', id: 'turn-cost-anchor', order: 10 },
              ComposerAnchor,
            ),
          );
        } catch (error) {
          console.error('[turn-cost] composer anchor registration failed', error);
        }
      },
    };
  },
});

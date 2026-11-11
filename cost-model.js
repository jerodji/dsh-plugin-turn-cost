/**
 * Turn cost — shared cost model (Host side).
 *
 * A pure, dependency-free fold over a Session log that produces the compact,
 * reusable summary the client displays:
 *
 *   per turn   id, startedAt/endedAt, model, peak, token buckets,
 *              web tool counts (search / fetch / auxiliary Messages requests),
 *              costMicro (1e-6 CNY) and sessionCostMicro at that turn
 *   session    total costMicro, pricedTurn count, missing (!) turns, tokens
 *   session    title, synced from every `session/title` event (renames)
 *
 * Web tools: `web_search` / `web_fetch` calls are folded too. DeepSeek bills the
 * new Web Search / Fetch APIs per successful request (¥5 / 1,000 → ¥0.005), so
 * those requests are counted per turn and added to the turn amount. In the
 * default Messages-search mode each query is billed as tokens inside an
 * auxiliary Messages request (its usage never reaches the log), so no per-call
 * fee applies there; the fold still counts those auxiliary requests so the
 * client can say they exist without being priced.
 *
 * This module is imported by `index.js` (the Host projection unit) and by the
 * plain-Node test harness. Keep it free of DSH imports so both can load it.
 *
 * Units: every price is CNY per 1,000,000 tokens, so
 * `tokens × rate = micro-yuan` exactly (¥1 = 1,000,000 micro-CNY).
 */

/** Projection key the client reads with `useProjection('turnCost')`. */
export const PROJECTION_KEY = 'turnCost';

/** Bump when the state/view shape changes; the projection cache is versioned. */
/** Bumped when the projection state or its client-visible view changes shape. */
export const COST_MODEL_VERSION = 3;

/** Per-successful-request price of the Web Search / Fetch APIs, in micro-CNY. */
export const SEARCH_REQUEST_MICRO = 5000;
export const FETCH_REQUEST_MICRO = 5000;

/** Tool names whose provider requests are billed per call by those APIs. */
export const WEB_SEARCH_TOOL = 'web_search';
export const WEB_FETCH_TOOL = 'web_fetch';

/**
 * Session event the Messages search provider appends once per auxiliary
 * Messages request it sends. Each such request bills tokens, not a per-call fee.
 */
export const SEARCH_LLM_REQUEST_EVENT = 'web/deepseek-search-llm-request';

/** Which price list this model applies (shown in the tooltip footer). */
export const PRICE_VERSION = 'deepseek-cny-2026-11-11';

/** Peak-hour CNY list price per 1M tokens: cache hit / cache miss / output. */
export const PEAK_PRICES = {
  // deepseek-flash (DeepSeek-V4.1-Flash-1017) and the v4-flash aliases.
  flash: { hit: 0.04, miss: 2, output: 8 },
  // deepseek-v4-pro (DeepSeek-V4-Pro-0813).
  pro: { hit: 0.3, miss: 9, output: 27 },
  // Retired deepseek-chat / deepseek-reasoner ids keep their flat price.
  legacy: { hit: 0.2, miss: 2, output: 3 },
};

/**
 * Peak-hour US-dollar list price per 1M tokens (DeepSeek's official US$ table).
 * The USD table is NOT a flat FX conversion of the CNY one: per-model ratios
 * differ (flash 20/3 ≈ 6.6667, pro 75/11 ≈ 6.8182, legacy 50/7 ≈ 7.1429), so
 * amounts shown in USD are computed from these rates, not by dividing CNY.
 */
export const USD_PEAK_PRICES = {
  // deepseek-flash (DeepSeek-V4.1-Flash-1017) and the v4-flash aliases.
  flash: { hit: 0.006, miss: 0.3, output: 1.2 },
  // deepseek-v4-pro (DeepSeek-V4-Pro-0813).
  pro: { hit: 0.044, miss: 1.32, output: 3.96 },
  // Retired deepseek-chat / deepseek-reasoner ids keep their flat price.
  legacy: { hit: 0.028, miss: 0.28, output: 0.42 },
};

/** Per-successful-request price of the Web Search / Fetch APIs, in micro-USD. */
export const USD_SEARCH_REQUEST_MICRO = 750;
export const USD_FETCH_REQUEST_MICRO = 750;

export const PRICE_VERSION_USD = 'deepseek-usd-2026-11-11';

/** Assumed route when events carry no provider/model attribution. */
export const FALLBACK_MODEL = 'deepseek-flash';

/** Off-peak bills at exactly half of the peak list price (legacy ids are flat). */
export const OFF_PEAK_FACTOR = 0.5;

/** Beijing is UTC+8 all year; peak windows are read in that offset. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function classifyModel(model) {
  const id = String(model || '').toLowerCase();
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  if (id.includes('chat') || id.includes('reasoner')) return 'legacy';
  return undefined;
}

export function isPeak(time) {
  const raw = Number(time);
  const stamp = raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.now();
  const date = new Date(stamp + BEIJING_OFFSET_MS);
  const day = date.getUTCDay();
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

export function emptyTokens() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

function addTokens(target, usage) {
  target.uncachedInput += Number(usage.inputTokens) || 0;
  target.cacheRead += Number(usage.cacheReadTokens) || 0;
  target.cacheWrite += Number(usage.cacheWriteTokens) || 0;
  target.output += Number(usage.outputTokens) || 0;
  target.total += Number(usage.totalTokens) || 0;
}

/** The exact per-attempt usage of one `assistant/message` or `assistant/attempt` event. */
export function usageOf(data) {
  if (!data || typeof data !== 'object') return undefined;
  const direct = data.usage;
  if (direct && typeof direct.inputTokens === 'number' && typeof direct.outputTokens === 'number') {
    return {
      inputTokens: direct.inputTokens,
      outputTokens: direct.outputTokens,
      cacheReadTokens: direct.cacheReadTokens,
      cacheWriteTokens: direct.cacheWriteTokens,
      totalTokens:
        typeof direct.totalTokens === 'number'
          ? direct.totalTokens
          : direct.inputTokens + direct.outputTokens,
    };
  }
  // Fallback for events whose usage only exists as the final stream chunk.
  const stream = Array.isArray(data.stream) ? data.stream : undefined;
  if (stream === undefined) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const entry = stream[index];
    const chunk = entry && entry.chunk;
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      const usage = chunk.usage;
      if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
        return {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          totalTokens:
            typeof usage.totalTokens === 'number'
              ? usage.totalTokens
              : usage.inputTokens + usage.outputTokens,
        };
      }
    }
  }
  return undefined;
}

/** Route attribution of a settled message: `{provider, model}` when both exist. */
export function routeOf(data) {
  const source = data && (data.source || (data.message && data.message.source));
  if (!source || typeof source !== 'object') return undefined;
  const provider = typeof source.provider === 'string' ? source.provider : '';
  const model = typeof source.model === 'string' ? source.model : '';
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * Cost of one turn in micro-yuan (1e-6 CNY), rounded to the nearest micro.
 * Cache writes are billed at the cache-miss input rate (DeepSeek lists no
 * separate cache-write price).
 */
export function costMicroOf(tokens, modelKind, peak) {
  const base = PEAK_PRICES[modelKind];
  if (base === undefined) return null;
  const factor = modelKind === 'legacy' || peak ? 1 : OFF_PEAK_FACTOR;
  const hit = (Number(tokens.cacheRead) || 0) * base.hit * factor;
  const miss = ((Number(tokens.uncachedInput) || 0) + (Number(tokens.cacheWrite) || 0)) * base.miss * factor;
  const output = (Number(tokens.output) || 0) * base.output * factor;
  return Math.round(hit + miss + output);
}

/**
 * Cost of one turn in micro-USD, rounded to the nearest micro.
 * Same bucket rules as `costMicroOf`, priced from the official US$ table.
 */
export function usdCostMicroOf(tokens, modelKind, peak) {
  const base = USD_PEAK_PRICES[modelKind];
  if (base === undefined) return null;
  const factor = modelKind === 'legacy' || peak ? 1 : OFF_PEAK_FACTOR;
  const hit = (Number(tokens.cacheRead) || 0) * base.hit * factor;
  const miss = ((Number(tokens.uncachedInput) || 0) + (Number(tokens.cacheWrite) || 0)) * base.miss * factor;
  const output = (Number(tokens.output) || 0) * base.output * factor;
  return Math.round(hit + miss + output);
}

/**
 * A settled turn record's total in micro-USD: token cost plus the per-request
 * Search/Fetch fees billed in that turn (`null` when the model is unpriced).
 * Billed request counts are recovered from the CNY fee fields, which are an
 * exact multiple of the CNY per-request price.
 */
export function usdMicroOfTurn(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.empty === true) return 0;
  const cny = entry.costMicro;
  if (cny === null || cny === undefined) return null;
  const kind = classifyModel(entry.model);
  if (kind === undefined) return null;
  const peak = entry.period !== undefined && entry.period !== null ? entry.period === 'peak' : entry.peak === true;
  const tokenMicro = usdCostMicroOf(entry.tokens || {}, kind, peak) || 0;
  const billedSearch = Math.round((Number(entry.webSearchFeeMicro) || 0) / SEARCH_REQUEST_MICRO);
  const billedFetch = Math.round((Number(entry.webFetchFeeMicro) || 0) / FETCH_REQUEST_MICRO);
  return tokenMicro + billedSearch * USD_SEARCH_REQUEST_MICRO + billedFetch * USD_FETCH_REQUEST_MICRO;
}

/** Fresh projection state for one Session. */
export function createState(sessionId, inheritedEventCount = 0) {
  return {
    sessionId: String(sessionId || ''),
    title: null,
    priceVersion: PRICE_VERSION,
    turns: [],
    open: null,
    sessionCostMicro: 0,
    sessionTokens: emptyTokens(),
    // Billed web-tool totals for this Session: successful search queries,
    // successful fetches, auxiliary Messages search requests, and the amount
    // those per-call fees contributed to `sessionCostMicro`.
    sessionWeb: { search: 0, fetch: 0, messages: 0, feeMicro: 0 },
    // Latest observed web-tool billing mode: 'api' once a turn searched without
    // an auxiliary Messages request, 'messages' once one was observed. Carried
    // across turns so a fetch-only turn can still be billed after an API-mode
    // search, and used only for the fetch fee (search fees are per-call exact).
    webMode: null,
    missingTurns: [],
    inheritedEventCount: Number(inheritedEventCount) || 0,
    updatedAt: 0,
  };
}

/**
 * Number of search requests one `web_search` call sends: every distinct,
 * non-empty query is dispatched as its own provider request (the tool
 * de-duplicates with a Set before dispatching, in parallel).
 */
function searchRequestCount(args) {
  let parsed = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return 0;
    }
  }
  const queries = parsed && Array.isArray(parsed.queries) ? parsed.queries : [];
  const unique = new Set();
  for (const query of queries) {
    if (typeof query === 'string' && query.trim().length > 0) unique.add(query);
  }
  return unique.size;
}

/** `tool/result` payload: `data.message` in the durable log, else the data itself. */
function toolResultMessage(data) {
  if (!data || typeof data !== 'object') return undefined;
  if (data.message && typeof data.message === 'object') return data.message;
  return data;
}

function finalizeTurn(state, open, endedAt) {
  const tokens = emptyTokens();
  let model;
  for (const key of Object.keys(open.steps)) {
    const step = open.steps[key];
    addTokens(tokens, {
      inputTokens: step.tokens.uncachedInput,
      outputTokens: step.tokens.output,
      cacheReadTokens: step.tokens.cacheRead,
      cacheWriteTokens: step.tokens.cacheWrite,
      totalTokens: step.tokens.total,
    });
    model = model || step.model;
  }
  const turn = Number(open.turn) || 0;
  const hasUsage = tokens.total > 0;
  const kind = hasUsage ? classifyModel(model || FALLBACK_MODEL) : undefined;
  const peak = isPeak(endedAt);
  // Peak/off-peak tag stored alongside the amount so consumers never have to
  // re-derive it from the model + timestamp. Retired flat-price ids get 'flat'.
  const period = !hasUsage ? null : kind === 'legacy' ? 'flat' : peak ? 'peak' : 'offpeak';
  const tokenCostMicro = hasUsage && kind !== undefined ? costMicroOf(tokens, kind, peak) : hasUsage ? null : 0;

  // Web tools: a Messages-mode search bills as tokens inside one auxiliary
  // Messages request per query, so only the requests beyond those observed
  // auxiliary requests are per-call billable; the fetch fee applies only while
  // the Search/Fetch API provider is selected (carried by `webMode`).
  const searchRequests = Number(open.searchRequests) || 0;
  const fetchRequests = Number(open.fetchRequests) || 0;
  const messagesRequests = Number(open.messagesRequests) || 0;
  const billedSearchRequests = Math.max(0, searchRequests - messagesRequests);
  let webMode = state.webMode;
  if (searchRequests > 0) webMode = messagesRequests > 0 ? 'messages' : 'api';
  const billedFetchRequests = webMode === 'api' ? fetchRequests : 0;
  // A turn with no settled usage (aborted before its assistant message) stays
  // "empty": it shows no footer row, so its web fee is counted in the record
  // but not charged — that keeps the footer's session sum and this total equal.
  const chargeable = hasUsage && tokenCostMicro !== null;
  const searchFeeMicro = chargeable ? billedSearchRequests * SEARCH_REQUEST_MICRO : 0;
  const fetchFeeMicro = chargeable ? billedFetchRequests * FETCH_REQUEST_MICRO : 0;
  const webFeeMicro = searchFeeMicro + fetchFeeMicro;
  const costMicro = tokenCostMicro === null ? null : tokenCostMicro + webFeeMicro;
  const sessionCostMicro = state.sessionCostMicro + (costMicro || 0);
  const entry = {
    id: `${state.sessionId}:${turn}`,
    turn,
    startedAt: Number(open.startedAt) || 0,
    endedAt: Number(endedAt) || 0,
    model: hasUsage ? model || FALLBACK_MODEL : null,
    peak,
    period,
    tokens,
    costMicro,
    // Web-tool usage this turn: successful search queries, successful fetches,
    // auxiliary Messages search requests, and the per-call fee included in
    // `costMicro` (0 when the turn billed no per-call fee).
    webSearchRequests: searchRequests,
    webFetchRequests: fetchRequests,
    webMessagesRequests: messagesRequests,
    webSearchFeeMicro: searchFeeMicro,
    webFetchFeeMicro: fetchFeeMicro,
    webFeeMicro,
    webSearchBilled: searchFeeMicro > 0,
    webFetchBilled: fetchFeeMicro > 0,
    // `empty` turns ended without any settled assistant usage (the user
    // aborted them, or every attempt failed). They display no row and never
    // turn the session amount into a lower bound.
    empty: !hasUsage,
    sessionCostMicro,
  };
  const next = {
    ...state,
    turns: state.turns.concat([entry]),
    open: null,
    sessionCostMicro,
    sessionTokens: addSessionTokens(state.sessionTokens, tokens),
    sessionWeb: {
      search: state.sessionWeb.search + searchRequests,
      fetch: state.sessionWeb.fetch + fetchRequests,
      messages: state.sessionWeb.messages + messagesRequests,
      feeMicro: state.sessionWeb.feeMicro + webFeeMicro,
    },
    webMode,
    missingTurns: costMicro === null ? state.missingTurns.concat([turn]) : state.missingTurns,
    updatedAt: Number(endedAt) || state.updatedAt,
  };
  return next;
}

function addSessionTokens(base, tokens) {
  return {
    uncachedInput: base.uncachedInput + tokens.uncachedInput,
    cacheRead: base.cacheRead + tokens.cacheRead,
    cacheWrite: base.cacheWrite + tokens.cacheWrite,
    output: base.output + tokens.output,
    total: base.total + tokens.total,
  };
}

/** One committed Session event in, one (possibly identical) state out. */
export function foldEvent(state, event) {
  if (!event || typeof event.type !== 'string') return state;
  if ((Number(event.seq) || 0) < state.inheritedEventCount) return state;
  const data = event.data;

  if (event.type === 'session/title') {
    const title = data && typeof data.title === 'string' ? data.title : null;
    if (title === state.title) return state;
    return { ...state, title, updatedAt: Number(event.time) || state.updatedAt };
  }

  if (event.type === 'turn/start') {
    const turn = Number(data && data.turn) || 0;
    if (turn <= 0) return state;
    return {
      ...state,
      open: {
        turn,
        startedAt: Number(event.time) || 0,
        steps: {},
        // Pending web-tool calls of this turn, keyed by toolCallId:
        // `{name, requests}` until their `tool/result` settles them.
        calls: {},
        searchRequests: 0,
        fetchRequests: 0,
        messagesRequests: 0,
      },
      updatedAt: Number(event.time) || state.updatedAt,
    };
  }

  if (event.type === 'tool/call') {
    const open = state.open;
    if (!open || !data || typeof data !== 'object') return state;
    const name = data.name;
    if (name !== WEB_SEARCH_TOOL && name !== WEB_FETCH_TOOL) return state;
    const callId = typeof data.callId === 'string' ? data.callId : undefined;
    if (callId === undefined) return state;
    const calls = { ...open.calls };
    calls[callId] = {
      name,
      requests: name === WEB_SEARCH_TOOL ? searchRequestCount(data.arguments) : 1,
    };
    return {
      ...state,
      open: { ...open, calls },
      updatedAt: Number(event.time) || state.updatedAt,
    };
  }

  if (event.type === 'tool/result') {
    const open = state.open;
    if (!open) return state;
    const message = toolResultMessage(data);
    const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (callId === undefined) return state;
    const call = open.calls[callId];
    // Not one of our pending web-tool calls (other tools, or a call folded
    // before this state's inherited cut): nothing to record.
    if (call === undefined) return state;
    const calls = { ...open.calls };
    delete calls[callId];
    // Failed calls performed no billable request; interrupted ones may not have
    // logged a result at all, so the pending map is only a per-turn scratchpad.
    if (message.isError === true) {
      return { ...state, open: { ...open, calls }, updatedAt: Number(event.time) || state.updatedAt };
    }
    return {
      ...state,
      open: {
        ...open,
        calls,
        searchRequests: call.name === WEB_SEARCH_TOOL ? open.searchRequests + call.requests : open.searchRequests,
        fetchRequests: call.name === WEB_FETCH_TOOL ? open.fetchRequests + call.requests : open.fetchRequests,
      },
      updatedAt: Number(event.time) || state.updatedAt,
    };
  }

  if (event.type === SEARCH_LLM_REQUEST_EVENT) {
    const open = state.open;
    if (!open) return state;
    return {
      ...state,
      open: { ...open, messagesRequests: open.messagesRequests + 1 },
      updatedAt: Number(event.time) || state.updatedAt,
    };
  }

  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const open = state.open;
    if (!open) return state;
    if (Number(data && data.turn) !== open.turn) return state;
    const usage = usageOf(data);
    if (!usage || !(Number(usage.totalTokens) > 0)) return state;
    const step = String(Number(data && data.step) || 0);
    const route = routeOf(data);
    // Per step the settled sample wins: a retried step is billed once, at the
    // last attempt that actually settled with usage.
    const steps = { ...open.steps };
    steps[step] = { tokens: bucketOf(usage), model: route ? route.model : undefined };
    return {
      ...state,
      open: { ...open, steps },
      updatedAt: Number(event.time) || state.updatedAt,
    };
  }

  if (event.type === 'turn/end') {
    const open = state.open;
    if (!open) return state;
    if (Number(data && data.turn) !== open.turn) return state;
    return finalizeTurn(state, open, Number(event.time) || 0);
  }

  return state;
}

function bucketOf(usage) {
  const tokens = emptyTokens();
  addTokens(tokens, usage);
  return tokens;
}

/** Compact, client-visible view of one Session's log. */
export function viewOf(state) {
  return {
    v: COST_MODEL_VERSION,
    sessionId: state.sessionId,
    title: state.title,
    priceVersion: state.priceVersion,
    updatedAt: state.updatedAt,
    turns: state.turns,
    session: {
      costMicro: state.sessionCostMicro,
      turns: state.turns.length,
      pricedTurns: state.turns.length - state.missingTurns.length,
      missingTurns: state.missingTurns,
      tokens: state.sessionTokens,
      web: state.sessionWeb,
    },
  };
}

/** Fold a whole event array (test/backfill helper). */
export function foldAll(events, sessionId, inheritedEventCount = 0) {
  let state = createState(sessionId, inheritedEventCount);
  for (const event of events) state = foldEvent(state, event);
  return state;
}

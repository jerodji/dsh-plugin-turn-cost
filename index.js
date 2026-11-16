/**
 * Turn cost — Host half.
 *
 * Registers a Session projection unit (`turnCost`) that folds the whole
 * durable Session log into a compact per-turn / per-session summary. The client
 * half reads it with `useProjection('turnCost')`, so the last visible turn can
 * show the correct cumulative amount even when earlier turns are not loaded in
 * the chat window — nothing is recomputed from the loaded window.
 *
 * The fold also records the Session title from `session/title` events, so a
 * rename updates the projected record automatically.
 *
 * All pricing logic lives in `./cost-model.js` (dependency-free, unit-tested).
 */
import { readFileSync } from 'node:fs';
import {
  COST_MODEL_VERSION,
  PROJECTION_KEY,
  createState,
  foldEvent,
  mergeModelNames,
  setPlanProviders,
  setPriceBook,
  setSelectionLookup,
  viewOf,
} from './cost-model.js';
import { cnyPriceBookInfo, setCnyPriceBook } from './cny-prices.js';
import { detectPlanProviders, loadPriceCatalog } from './price-catalog.js';
import { flushSelections, loadSelections, lookupSelection, rememberSelection } from './selection-log.js';
import { STATE_ROUTE, handleStateRequest } from './billing.js';
export const inject = ['sessionProjections'];

/** Identity-only schemas: the fold produces plain JSON, so no validation is needed. */
const identitySchema = {
  parse: (value) => value,
};

export const TURN_COST_PROJECTION = {
  key: PROJECTION_KEY,
  stateVersion: COST_MODEL_VERSION,
  stateSchema: identitySchema,
  init: (header, inheritedEventCount) => createState(header && header.id, inheritedEventCount),
  apply: (state, event) => foldEvent(state, event),
  wire: {
    // Keep it out of session-list summaries: the list only needs cheap hints,
    // while the full per-turn record is served for an opened Session.
    summary: false,
    viewSchema: identitySchema,
    view: (state) => viewOf(state),
  },
};

/**
 * Resolve provider/model display names in the background. Each provider lookup
 * is bounded so a slow (or offline) adapter cannot stall the Host.
 */
async function resolveModelNames(ctx, llm) {
  const names = {};
  try {
    for (const provider of llm.listProviders()) {
      const providerId = provider && typeof provider.id === 'string' ? provider.id : '';
      if (providerId === '') continue;
      const models = await withTimeout(Promise.resolve(llm.listModels(providerId)), 2000);
      for (const model of Array.isArray(models) ? models : []) {
        if (model && typeof model.id === 'string' && typeof model.name === 'string' && model.name.length > 0) {
          names[`${providerId}\u0000${model.id}`] = model.name;
        }
      }
    }
    const count = mergeModelNames(names);
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(`turn-cost: model display names loaded (${count})`);
    }
  } catch (error) {
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn(new Error(`turn-cost: cannot resolve model display names: ${String(error)}`));
    }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Run one asynchronous task once a group of Host services is available. The
 * wait is bounded: a Host that never mounts (headless, tests) must still load
 * the plugin, just with the conservative built-in plan list. Resolving `apply`
 * only after this task keeps the plan classification out of a replay race: the
 * projection folds every stored Session the moment it is registered.
 */
function withHostServices(ctx, services, task, ms = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      ctx.inject(services, (scoped) => {
        Promise.resolve()
          .then(() => task(scoped))
          .then(finish, () => finish(undefined));
      });
    } catch {
      finish(undefined);
    }
    const timer = setTimeout(() => finish(undefined), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Providers paid by a subscription plan. Two offline facts feed this:
 * - the stored credential kind on a pi-ai route (OAuth grant on a provider
 *   whose OAuth login is a subscription, versus an API key that is metered);
 * - the provider display name for subscription adapters that register plain
 *   routes without pi-ai metadata (ChatGPT subscription, Copilot, Claude
 *   Subscription, Grok Subscription, Antigravity).
 * A provider selling both routes is classified by the credential actually
 * stored; a missing or unreachable service falls back to the built-in list in
 * cost-model.js.
 */
async function resolvePlanProviders(ctx, catalog) {
  const plans = await withHostServices(ctx, ['llm', 'credentials'], async (scoped) => {
    const records =
      scoped.credentials && typeof scoped.credentials.listRecords === 'function'
        ? await scoped.credentials.listRecords()
        : [];
    const providers = scoped.llm && typeof scoped.llm.listProviders === 'function' ? scoped.llm.listProviders() : [];
    return detectPlanProviders(catalog, records, providers);
  });
  return Array.isArray(plans) ? plans : [];
}

/**
 * Local RMB price file for domestic vendors (Zhipu GLM, Moonshot Kimi, Alibaba
 * Qwen, ByteDance Doubao/Seed). It ships as `prices/cny-models.json` so a
 * vendor price change is a data edit, not a code change. Missing or invalid
 * file => empty book => those models fall back to the USD catalog with `≈`.
 */
function loadCnyPriceFile() {
  const file = new URL('./prices/cny-models.json', import.meta.url);
  try {
    return { raw: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error };
  }
}

export async function apply(ctx) {
  // Offline price source: the pi-ai provider catalogs bundled with the app.
  // Loading happens once per Host process start and costs no network request;
  // a model switch is a plain in-memory lookup afterwards. Without the catalog
  // only DeepSeek models are priced, everything else reports as unknown.
  const catalog = loadPriceCatalog();
  if (catalog !== undefined) {
    const book = setPriceBook(catalog);
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(
        `turn-cost: price catalog "${book.version}" loaded (${book.models} models, ${Object.keys(book.providers).length} providers)`,
      );
    }
  } else if (typeof ctx.logger?.warn === 'function') {
    ctx.logger.warn(new Error('turn-cost: bundled price catalog unavailable; non-DeepSeek models will be unknown'));
  }

  // Official RMB list for domestic vendors. Loaded before the projection is
  // registered because the registration replays stored Sessions immediately.
  const cnyFile = loadCnyPriceFile();
  if (cnyFile.raw !== undefined) {
    const cny = setCnyPriceBook(cnyFile.raw);
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(`turn-cost: CNY price file "${cny.version}" loaded (${cny.entries} model entries)`);
    }
  } else if (typeof ctx.logger?.warn === 'function') {
    ctx.logger.warn(
      new Error(
        `turn-cost: CNY price file unavailable (${cnyFile.error && cnyFile.error.message}); domestic models will fall back to the USD catalog`,
      ),
    );
  }

  // Plan vs metered route. Classify before registering the projection: the
  // registration replays every stored Session immediately, and a turn's plan /
  // priced status is decided while folding, not while rendering.
  const planIds = await resolvePlanProviders(ctx, catalog);
  setPlanProviders(planIds);
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(`turn-cost: subscription-plan providers ${planIds.length > 0 ? planIds.join(', ') : '(none)'}`);
  }

  // Exact per-turn reasoning effort: `agent/pre-step` carries the resolved
  // model selection (provider/model/reasoningEffort) of the step that is about
  // to run. The durable log records a request header only on change, so this is
  // the only per-turn source; records are persisted next to the profile data.
  await loadSelections();
  setSelectionLookup((sessionId, turn) => lookupSelection(sessionId, turn));
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload && payload.agent;
      const sessionId = (agent && agent.session && agent.session.id) || (payload && payload.sessionId) || (agent && agent.id);
      const turn = payload && payload.turn;
      const selection = payload && payload.modelSelection;
      if (sessionId !== undefined && selection && typeof selection === 'object') {
        rememberSelection(String(sessionId), turn, {
          provider: selection.provider,
          model: selection.model,
          effort: selection.effort !== undefined ? selection.effort : selection.reasoningEffort,
          step: payload && payload.step,
        });
      }
    } catch {
      // Never break the agent loop for bookkeeping.
    }
    return next();
  });

  await ctx.sessionProjections.register(TURN_COST_PROJECTION);
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(`turn-cost: projection "${PROJECTION_KEY}" v${COST_MODEL_VERSION} registered`);
  }

  ctx.on('session/flush', () => flushSelections());

  // Display names for the footer label. The model catalog lives behind the
  // asynchronous `llm` service and some adapters may query the network, so the
  // projection did NOT wait for it: viewOf resolves names at serialization time.
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm;
    if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
      void resolveModelNames(llmCtx, llm);
    }
  });

  // The Client half has no package-private Host RPC, so the Settings page and
  // the balance reminder read their data from this small same-origin route.
  // Prefer Connection's exact Fetch registry: it applies the Host/Origin fence
  // and requires an authenticated owner Peer for us. `inject` keeps the route
  // optional — a headless Host still registers the projection, it just never
  // serves the Settings data.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register({
        path: STATE_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleStateRequest(connectionCtx, request),
      }),
    );
    if (typeof connectionCtx.logger?.info === 'function') {
      connectionCtx.logger.info(`turn-cost: state route "${STATE_ROUTE}" registered`);
    }
  });

  // Fallback for a deployment without the Connection service: register the same
  // data on the raw web server and rely on the handler's own header/Host guards.
  ctx.inject(['webServer'], (webCtx) => {
    if (webCtx.get('connection') !== undefined) return;
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        resource: (request) => handleStateRequest(webCtx, request),
      }),
    );
  });
}

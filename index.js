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
import {
  COST_MODEL_VERSION,
  PROJECTION_KEY,
  createState,
  foldEvent,
  mergeModelNames,
  setPlanProviders,
  setPriceBook,
  viewOf,
} from './cost-model.js';
import { loadPriceCatalog } from './price-catalog.js';
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

  await ctx.sessionProjections.register(TURN_COST_PROJECTION);
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(`turn-cost: projection "${PROJECTION_KEY}" v${COST_MODEL_VERSION} registered`);
  }

  // Subscription detection: an OAuth grant stored for llm-pi-ai means that
  // provider is billed by a plan (ChatGPT Plus/Pro, Claude Pro/Max, Copilot,
  // Kimi coding), not per token. The credential seam reports records without
  // values, which is exactly the "is this route a subscription" fact we need.
  ctx.inject(['credentials'], (credentialCtx) => {
    Promise.resolve()
      .then(() => credentialCtx.credentials.listRecords())
      .then((records) => {
        const plans = [];
        for (const record of Array.isArray(records) ? records : []) {
          const key = String(record && record.key ? record.key : '');
          const slash = key.indexOf('/');
          if (slash < 0 || key.slice(0, slash) !== 'llm-pi-ai') continue;
          if (record.kind === 'api-key') continue;
          const id = key.slice(slash + 1);
          if (id !== '' && !plans.includes(id)) plans.push(id);
        }
        setPlanProviders(plans);
        if (typeof credentialCtx.logger?.info === 'function') {
          credentialCtx.logger.info(`turn-cost: subscription providers ${plans.length > 0 ? plans.join(', ') : '(none)'}`);
        }
      })
      .catch((error) => {
        if (typeof credentialCtx.logger?.warn === 'function') {
          credentialCtx.logger.warn(new Error(`turn-cost: cannot read credential records: ${String(error)}`));
        }
      });
  });

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

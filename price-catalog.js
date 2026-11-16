/**
 * Turn cost — Host half: offline model price catalog.
 *
 * DeepSeek Harness ships the pi-ai SDK, whose `providers/data/*.json` files
 * describe every model it knows with a `cost` object (USD per 1,000,000
 * tokens). Reading those files gives the Host half an offline price table for
 * non-DeepSeek providers: no network request, no API key, no per-day quota, and
 * it is exactly the price data the app itself is built against.
 *
 * The catalog is read once per Host process start (the user's "fetch the default
 * model price at startup" requirement) and looked up in memory afterwards, so a
 * model switch costs nothing. When the files are unavailable (e.g. a headless
 * build without the desktop resources) the book stays empty and every
 * non-DeepSeek model is reported as unknown instead of being billed by guess.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'dsh/node_modules/@earendil-works/pi-ai/dist/providers/data';

function candidateDirs() {
  const dirs = [];
  const resources = typeof process !== 'undefined' ? process.resourcesPath : undefined;
  if (typeof resources === 'string' && resources.length > 0) {
    dirs.push(path.join(resources, 'app.asar', DATA_DIR));
    dirs.push(path.join(resources, 'app.asar.unpacked', DATA_DIR));
  }
  // A source checkout can point the loader at a plain directory.
  const dev = typeof process !== 'undefined' ? process.env.DSH_PI_AI_DATA : undefined;
  if (typeof dev === 'string' && dev.length > 0) dirs.unshift(dev);
  return dirs;
}

/**
 * Read each pi-ai provider definition's auth shape.
 *
 * `providers/<id>.js` builds its provider with
 * `createProvider({ id: "…", auth: { … }, … })`. Two independent facts matter:
 *
 * - `oauth: lazyOAuth({ …, isSubscription: true })` marks a provider whose OAuth
 *   login is a subscription plan (ChatGPT Plus/Pro, Copilot, Claude Pro/Max,
 *   Kimi Code, SuperGrok). The plan quota, not a token price, pays for it.
 * - `apiKey: …` marks a route that can be driven with a plain API key. The same
 *   provider may offer both (OpenAI, Anthropic, Kimi, Copilot), or OAuth that is
 *   *not* a subscription (OpenRouter), or only an API key (DeepSeek, Z.AI).
 *
 * `plans` (OAuth subscription and no API-key route) is the conservative set that
 * is always a quota plan. `oauthSubscriptions` is the larger set used together
 * with the credential actually stored for that provider: an OAuth grant on such
 * a provider is a subscription plan, while an API key on it is metered.
 */
function readProviderAuth(providersDir) {
  const plans = [];
  const oauthSubscriptions = [];
  const apiKeyProviders = [];
  let names;
  try {
    names = fs.readdirSync(providersDir);
  } catch {
    return { plans, oauthSubscriptions, apiKeyProviders };
  }
  for (const name of names) {
    if (!name.endsWith('.js') || name.endsWith('.models.js')) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(providersDir, name), 'utf8');
    } catch {
      continue;
    }
    if (!/createProvider\s*\(/.test(source)) continue;
    const match = source.match(/id\s*:\s*"([^"]+)"/);
    if (match === null) continue;
    const id = match[1];
    const subscription = /isSubscription\s*:\s*true/.test(source);
    const hasApiKey = /\bapiKey\s*:/.test(source);
    if (subscription) {
      if (!oauthSubscriptions.includes(id)) oauthSubscriptions.push(id);
      if (!hasApiKey && !plans.includes(id)) plans.push(id);
    }
    if (hasApiKey && !apiKeyProviders.includes(id)) apiKeyProviders.push(id);
  }
  return { plans, oauthSubscriptions, apiKeyProviders };
}

/**
 * Which providers are quota plans, given the stored credential records.
 *
 * An OAuth grant on a provider whose OAuth login is a subscription
 * (`isSubscription: true`) is a monthly/quarterly/yearly plan: the turn shows
 * "本轮消耗订阅额度". Everything else — an API key, or an OAuth login that is
 * merely a sign-in for a metered API (OpenRouter) — is billed per token and is
 * priced from the model catalog like any other API route.
 *
 * Records are `{ key: 'llm-pi-ai/<provider>', kind: 'api-key' | 'grant' | … }`.
 * A provider with both an API key and an OAuth grant prefers the grant: the
 * OAuth login is the subscription route the user signed in with.
 */
export function planProvidersFromRecords(records, oauthSubscriptions) {
  const subscriptions = new Set();
  for (const id of Array.isArray(oauthSubscriptions) ? oauthSubscriptions : []) {
    subscriptions.add(String(id || '').toLowerCase());
  }
  const grants = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const key = String(record && record.key ? record.key : '');
    const slash = key.indexOf('/');
    if (slash < 0 || key.slice(0, slash) !== 'llm-pi-ai') continue;
    if (record.kind === 'api-key') continue;
    const id = key.slice(slash + 1).toLowerCase();
    if (id !== '') grants.add(id);
  }
  const plans = [];
  for (const id of grants) {
    if (subscriptions.has(id) && !plans.includes(id)) plans.push(id);
  }
  return plans;
}

/**
 * Display names the subscription adapters give their provider routes. The
 * `dsh-plugin-subscriptions` package registers plain adapters (`codex`,
 * `claude`, `grok`, `copilot`, `antigravity`) without pi-ai provider metadata,
 * so the localized display name is the only offline signal that the route is a
 * monthly/quarterly/yearly plan rather than a metered API.
 */
const SUBSCRIPTION_NAME_PATTERN = /subscription|copilot|antigravity|chatgpt|订阅/i;

/**
 * Final plan-provider list for the fold: stored OAuth subscriptions plus routes
 * whose display name names a subscription product. Everything else is priced
 * per token from the model catalog (an unknown price still shows 未知 rather
 * than pretending to be a plan).
 */
export function detectPlanProviders(catalog, records, providers) {
  const plans = new Set(
    planProvidersFromRecords(records, catalog && catalog.oauthSubscriptions).map((id) => String(id).toLowerCase()),
  );
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = String(provider && provider.id ? provider.id : '').trim().toLowerCase();
    const name = String(provider && provider.name ? provider.name : '');
    if (id !== '' && name !== '' && SUBSCRIPTION_NAME_PATTERN.test(name)) plans.add(id);
  }
  return [...plans];
}

function readCatalogDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const providers = {};
  let models = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const fallbackProvider = name.slice(0, -5);
    for (const api of Object.keys(parsed)) {
      const table = parsed[api];
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
      for (const key of Object.keys(table)) {
        const record = table[key];
        if (!record || typeof record !== 'object') continue;
        const cost = record.cost;
        if (!cost || typeof cost !== 'object') continue;
        const input = Number(cost.input);
        const output = Number(cost.output);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const provider = typeof record.provider === 'string' && record.provider !== '' ? record.provider : fallbackProvider;
        const modelId = typeof record.id === 'string' && record.id !== '' ? record.id : key.replace(/^chat:/, '');
        if (!providers[provider]) providers[provider] = {};
        if (providers[provider][modelId] !== undefined) continue;
        providers[provider][modelId] = {
          ...(typeof record.name === 'string' && record.name !== '' ? { name: record.name } : {}),
          input,
          output,
          cacheRead: Number.isFinite(Number(cost.cacheRead)) ? Number(cost.cacheRead) : 0,
          cacheWrite: Number.isFinite(Number(cost.cacheWrite)) ? Number(cost.cacheWrite) : 0,
        };
        models += 1;
      }
    }
  }
  if (models === 0) return undefined;
  return { providers, models, version: 'pi-ai-catalog', loadedAt: Date.now() };
}

/**
 * Load the bundled catalog. Returns `{providers, models, version, loadedAt}` or
 * `undefined` when no catalog directory is readable.
 */
export function loadPriceCatalog() {
  const providersDirOverride =
    typeof process !== 'undefined' ? process.env.DSH_PI_AI_PROVIDERS : undefined;
  for (const dir of candidateDirs()) {
    const book = readCatalogDir(dir);
    if (book === undefined) continue;
    const providersDir =
      typeof providersDirOverride === 'string' && providersDirOverride.length > 0
        ? providersDirOverride
        : path.dirname(dir);
    const auth = readProviderAuth(providersDir);
    book.plans = auth.plans;
    book.oauthSubscriptions = auth.oauthSubscriptions;
    book.apiKeyProviders = auth.apiKeyProviders;
    return book;
  }
  return undefined;
}

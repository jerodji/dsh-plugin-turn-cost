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
 * Provider ids the pi-ai provider definitions mark as subscription plans.
 *
 * Each `providers/<id>.js` file builds its provider with
 * `createProvider({ id: "…", auth: { oauth: lazyOAuth({ …, isSubscription: true }) } })`.
 * A provider that also declares an `apiKey` auth is left out: it may be billed
 * per token (for example OpenAI / Anthropic with an API key), and mislabelling a
 * metered provider as a plan would hide real spend.
 */
function readPlanProviders(providersDir) {
  const plans = [];
  let names;
  try {
    names = fs.readdirSync(providersDir);
  } catch {
    return plans;
  }
  for (const name of names) {
    if (!name.endsWith('.js') || name.endsWith('.models.js')) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(providersDir, name), 'utf8');
    } catch {
      continue;
    }
    if (!/isSubscription\s*:\s*true/.test(source)) continue;
    if (/\bapiKey\s*:/.test(source)) continue;
    const match = source.match(/id\s*:\s*"([^"]+)"/);
    if (match === null) continue;
    const id = match[1];
    if (!plans.includes(id)) plans.push(id);
  }
  return plans;
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
    book.plans = readPlanProviders(providersDir);
    return book;
  }
  return undefined;
}

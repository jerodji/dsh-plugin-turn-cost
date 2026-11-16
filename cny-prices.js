/**
 * Official RMB (CNY) price table for domestic model vendors.
 *
 * The pi-ai catalog that ships inside DSH only publishes USD prices, and the
 * USD list is NOT an FX conversion of the vendor's RMB list (GLM-5.3 is
 * $1.4/4.4 in the catalog but ¥8/28 on BigModel). So a CNY turn must be priced
 * from the vendor's own RMB card, while a USD turn uses the vendor's USD card.
 *
 * All entries live in `prices/cny-models.json`, next to this file, so a vendor
 * price change only requires editing that JSON (then restarting DSH so the
 * Host half reloads the file). This module is pure: the Host loader feeds the
 * parsed JSON into `setCnyPriceBook`, and both the projection fold and the
 * billing aggregation read it through `cnyPriceFor`.
 *
 * JSON shape:
 * {
 *   "version": "2026-11-16",
 *   "unit": "CNY per 1M tokens",
 *   "sources": { "zhipu": "https://…" },
 *   "providers": [
 *     {
 *       "id": "zhipu",
 *       "providerPattern": "^(zai|bigmodel|zhipu)",
 *       "entries": [
 *         { "match": "^glm-5\\.3$", "input": 8, "output": 28, "cacheRead": 2 },
 *         { "match": "^glm-5\\.1$", "tiers": [
 *             { "maxInput": 32768, "rates": { "input": 6, "output": 24, "cacheRead": 1.3 } },
 *             { "rates": { "input": 8, "output": 28, "cacheRead": 2 } }
 *         ] }
 *       ]
 *     }
 *   ]
 * }
 *
 * `match` and `providerPattern` are JavaScript regex source strings. Prices are
 * 元 per 1,000,000 tokens. Tiers are checked in order: a tier applies while the
 * prompt (`maxInput`, exclusive) and output (`maxOutput`, exclusive) stay below
 * their bounds; the last tier should have no bounds and acts as the fallback.
 */

let book = { version: 'none', loadedAt: 0, providers: [], entries: 0 };

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function normalizeRates(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = numeric(raw.input);
  const output = numeric(raw.output);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: numeric(raw.cacheRead) || 0,
    cacheWrite: numeric(raw.cacheWrite) || 0,
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.match !== 'string') return undefined;
  let regex;
  try {
    regex = new RegExp(raw.match, 'i');
  } catch {
    return undefined;
  }
  const tiers = [];
  if (Array.isArray(raw.tiers)) {
    for (const tier of raw.tiers) {
      if (!tier || typeof tier !== 'object') continue;
      const rates = normalizeRates(tier.rates);
      if (!rates) continue;
      tiers.push({
        maxInput: numeric(tier.maxInput),
        maxOutput: numeric(tier.maxOutput),
        rates,
      });
    }
  }
  if (tiers.length === 0) {
    const rates = normalizeRates(raw);
    if (!rates) return undefined;
    tiers.push({ maxInput: undefined, maxOutput: undefined, rates });
  }
  return { regex, tiers };
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return undefined;
  let providerRegex = null;
  if (typeof raw.providerPattern === 'string') {
    try {
      providerRegex = new RegExp(raw.providerPattern, 'i');
    } catch {
      providerRegex = null;
    }
  }
  const entries = [];
  for (const entryRaw of raw.entries) {
    const entry = normalizeEntry(entryRaw);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    providerRegex,
    entries,
  };
}

/**
 * Install a parsed `prices/cny-models.json`. Invalid or empty input resets the
 * book to "none", which makes every non-DeepSeek model fall back to the USD
 * catalog with the `≈` marker instead of silently inventing an RMB amount.
 */
export function setCnyPriceBook(raw) {
  const next = { version: 'none', loadedAt: Date.now(), providers: [], entries: 0 };
  if (raw && typeof raw === 'object' && Array.isArray(raw.providers)) {
    for (const providerRaw of raw.providers) {
      const provider = normalizeProvider(providerRaw);
      if (!provider) continue;
      next.providers.push(provider);
      next.entries += provider.entries.length;
    }
    if (next.providers.length > 0) {
      next.version = typeof raw.version === 'string' ? raw.version : 'bundled';
    }
  }
  book = next;
  return book;
}

/** Snapshot for the Host startup log. */
export function cnyPriceBookInfo() {
  return { version: book.version, entries: book.entries, loadedAt: book.loadedAt };
}

function pickRates(entry, inputTokens, outputTokens) {
  let rates = entry.tiers[entry.tiers.length - 1].rates;
  for (const tier of entry.tiers) {
    if (tier.maxInput !== undefined && inputTokens >= tier.maxInput) continue;
    if (tier.maxOutput !== undefined && outputTokens >= tier.maxOutput) continue;
    rates = tier.rates;
    break;
  }
  return { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite };
}

/**
 * Official RMB rates for this route, or `undefined` when the provider/model is
 * not in the local file (callers then use the USD catalog + `≈` conversion).
 */
export function cnyPriceFor(provider, model, tokens) {
  if (book.providers.length === 0) return undefined;
  const providerId = String(provider || '').toLowerCase();
  const modelId = String(model || '').toLowerCase();
  const inputTokens =
    (Number(tokens && tokens.uncachedInput) || 0) +
    (Number(tokens && tokens.cacheRead) || 0) +
    (Number(tokens && tokens.cacheWrite) || 0);
  const outputTokens = Number(tokens && tokens.output) || 0;
  for (const providerEntry of book.providers) {
    if (providerEntry.providerRegex && !providerEntry.providerRegex.test(providerId)) continue;
    for (const entry of providerEntry.entries) {
      if (!entry.regex.test(modelId)) continue;
      return pickRates(entry, inputTokens, outputTokens);
    }
  }
  return undefined;
}

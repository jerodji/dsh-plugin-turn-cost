/**
 * Per-turn model selections recorded from the live agent loop.
 *
 * The harness writes a `request/header` event only when the request header
 * changes (in practice: once per process start), so the durable Session log
 * cannot answer "which reasoning effort did turn N actually use?" for every
 * turn. `agent/pre-step` exposes the resolved model selection for each step;
 * this module remembers the last step of every turn, keyed by Session and turn,
 * and persists it so the answer survives restarts and is never re-invented.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const FILE = path.join(os.homedir(), '.dsh', 'turn-cost-selections.json');
const WRITE_DELAY_MS = 800;

let sessions = {};
let loaded = false;
let timer;
/**
 * Serialized write chain. A flush that arrives while an earlier write is still
 * in flight must wait and then serialize the *current* map, otherwise a new
 * selection can be captured by neither write and is lost until the next flush.
 */
let queue = Promise.resolve();

function scheduleWrite() {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    // The debounced write must go through the exported flush; an undefined
    // local name here throws asynchronously and takes the whole Host down.
    void flushSelections();
  }, WRITE_DELAY_MS);
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
}

/** Load the persisted map once; a missing or corrupt file is simply empty. */
export async function loadSelections() {
  if (loaded) return;
  loaded = true;
  try {
    const text = await fsp.readFile(FILE, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.v === STORE_VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      sessions = parsed.sessions;
    }
  } catch {
    sessions = {};
  }
}

/** Last recorded selection for one turn, or undefined when never observed. */
export function lookupSelection(sessionId, turn) {
  const entry = sessions[String(sessionId)];
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry[String(turn)];
  if (!record || typeof record !== 'object') return undefined;
  return record;
}

/**
 * Remember the model selection of one step. The last step of a turn wins: a
 * later step of the same turn overwrites the previous record only when it
 * carries a selection, so an auxiliary call cannot erase a real one.
 */
export function rememberSelection(sessionId, turn, selection) {
  const id = String(sessionId || '');
  const turnNumber = Number(turn);
  if (id === '' || !Number.isFinite(turnNumber) || turnNumber < 1) return;
  if (!selection || typeof selection !== 'object') return;
  const provider = typeof selection.provider === 'string' ? selection.provider : undefined;
  const model = typeof selection.model === 'string' ? selection.model : undefined;
  const effort = typeof selection.effort === 'string' && selection.effort !== '' ? selection.effort : undefined;
  if (provider === undefined && model === undefined && effort === undefined) return;
  const bucket = sessions[id] && typeof sessions[id] === 'object' ? sessions[id] : (sessions[id] = {});
  const previous = bucket[turnNumber];
  const record = {
    provider: provider ?? previous?.provider,
    model: model ?? previous?.model,
    effort: effort ?? previous?.effort,
    step: Number(selection.step) || previous?.step,
    at: Date.now(),
  };
  bucket[turnNumber] = record;
  scheduleWrite();
}

/** Write the map now (atomic replace) and resolve once the write settled. */
export async function flushSelections() {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  // Queue whole writes; each queued job serializes the map at the moment it
  // runs, so a selection recorded during an earlier write is included by the
  // next job instead of being dropped.
  queue = queue.then(async () => {
    const payload = `${JSON.stringify({ v: STORE_VERSION, sessions })}\n`;
    try {
      await fsp.mkdir(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, FILE);
    } catch {
      // Persistence is best-effort: the projection cache and browser store are
      // the primary record, this file only protects replayed history.
    }
  });
  return queue;
}

export const SELECTION_FILE = FILE;
export const SELECTION_STORE_VERSION = STORE_VERSION;

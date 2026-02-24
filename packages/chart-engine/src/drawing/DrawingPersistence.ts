/**
 * DrawingPersistence.ts
 * Handles saving, loading, and syncing drawings with localStorage and the
 * Pinned REST API.
 */

import type { Drawing } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const LOCALSTORAGE_KEY = 'pinned-drawings';
const API_BASE = '/api/v1/drawings';

// ─── Local Storage ─────────────────────────────────────────────────────────────

/**
 * Build the localStorage key for a given symbol + timeframe pair.
 */
function storageKey(symbol: string, timeframe: string): string {
  return `${LOCALSTORAGE_KEY}:${symbol}:${timeframe}`;
}

/**
 * Save an array of drawings to localStorage for a specific symbol/timeframe.
 */
export function saveLocal(symbol: string, timeframe: string, drawings: Drawing[]): void {
  try {
    const key = storageKey(symbol, timeframe);
    const json = JSON.stringify(drawings);
    localStorage.setItem(key, json);
  } catch (err) {
    console.error('[DrawingPersistence] Failed to save to localStorage:', err);
  }
}

/**
 * Load drawings from localStorage for a specific symbol/timeframe.
 * Returns an empty array if nothing is stored or the data is corrupted.
 */
export function loadLocal(symbol: string, timeframe: string): Drawing[] {
  try {
    const key = storageKey(symbol, timeframe);
    const raw = localStorage.getItem(key);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Basic validation – each item must have at least an id and type.
    return parsed.filter(
      (d: unknown) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as Record<string, unknown>).id === 'string' &&
        typeof (d as Record<string, unknown>).type === 'string',
    ) as Drawing[];
  } catch {
    // Corrupted data – silently return empty.
    return [];
  }
}

// ─── Server Sync ───────────────────────────────────────────────────────────────

/**
 * POST a drawing to the server.
 * Throws on non-2xx responses; callers should catch and handle (e.g. 401).
 */
export async function saveToServer(drawing: Drawing): Promise<void> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(drawing),
  });

  if (res.status === 401) {
    throw new Error('Unauthorized – please log in to save drawings.');
  }
  if (!res.ok) {
    throw new Error(`Failed to save drawing to server (HTTP ${res.status}).`);
  }
}

/**
 * GET drawings from the server for a given symbol/timeframe.
 * Merges with any locally-stored drawings; server wins on ID conflicts.
 */
export async function loadFromServer(
  symbol: string,
  timeframe: string,
): Promise<Drawing[]> {
  const url = `${API_BASE}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;

  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

  if (!res.ok) {
    throw new Error(`Failed to load drawings from server (HTTP ${res.status}).`);
  }

  const serverDrawings: Drawing[] = await res.json();

  // Merge with local drawings – server takes precedence on ID conflict.
  const localDrawings = loadLocal(symbol, timeframe);
  const serverIds = new Set(serverDrawings.map((d) => d.id));
  const localOnly = localDrawings.filter((d) => !serverIds.has(d.id));

  return [...serverDrawings, ...localOnly];
}

/**
 * DELETE a drawing from the server by its ID.
 */
export async function deleteFromServer(drawingId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(drawingId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (res.status === 401) {
    throw new Error('Unauthorized – please log in to delete drawings.');
  }
  if (!res.ok) {
    throw new Error(`Failed to delete drawing from server (HTTP ${res.status}).`);
  }
}

/**
 * PUT (full update) a drawing on the server.
 */
export async function updateOnServer(drawing: Drawing): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(drawing.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(drawing),
  });

  if (res.status === 401) {
    throw new Error('Unauthorized – please log in to update drawings.');
  }
  if (!res.ok) {
    throw new Error(`Failed to update drawing on server (HTTP ${res.status}).`);
  }
}

// ─── Import / Export ───────────────────────────────────────────────────────────

/**
 * Serialise an array of drawings to a portable JSON string (for sharing).
 */
export function exportDrawings(drawings: Drawing[]): string {
  return JSON.stringify(drawings, null, 2);
}

/**
 * Parse and validate a JSON string, returning only valid Drawing objects.
 * Invalid or malformed data is silently dropped.
 */
export function importDrawings(json: string): Drawing[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((d: unknown): d is Drawing => {
      if (typeof d !== 'object' || d === null) return false;
      const rec = d as Record<string, unknown>;
      return (
        typeof rec.id === 'string' &&
        typeof rec.type === 'string' &&
        Array.isArray(rec.points) &&
        typeof rec.properties === 'object' &&
        rec.properties !== null
      );
    });
  } catch {
    return [];
  }
}

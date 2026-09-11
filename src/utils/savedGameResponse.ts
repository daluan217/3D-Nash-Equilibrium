import type { GamePayoffs } from '../types';

const PAYOFF_KEYS: readonly (keyof GamePayoffs)[] = [
  'a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22',
];
const OPTIONAL_TEXT_KEYS = [
  'row1Label', 'row2Label', 'col1Label', 'col2Label', 'clientRequestId',
] as const;
const OPTIONAL_TERM_KEYS = ['colorTermsA', 'colorTermsB'] as const;

export interface SavedGameResponseRecord {
  id: string;
  name: string;
  description?: string | null;
  payoffs: GamePayoffs;
  row1Label?: string | null;
  row2Label?: string | null;
  col1Label?: string | null;
  col2Label?: string | null;
  colorTermsA?: string[] | null;
  colorTermsB?: string[] | null;
  clientRequestId?: string | null;
}

/** The minimum complete game record that Save/Edit may commit to client state. */
export function isSavedGameResponseRecord(value: unknown): value is SavedGameResponseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const game = value as Record<string, unknown>;
  if (typeof game.id !== 'string' || game.id.trim() === '') return false;
  if (typeof game.name !== 'string' || game.name.trim() === '') return false;
  // Old rows predate several story fields. PATCH spreads those stored rows,
  // and the UI deliberately treats their missing/null values as empty, so a
  // successful unrelated edit must not be rejected solely for legacy shape.
  if (game.description != null && typeof game.description !== 'string') return false;
  if (!game.payoffs || typeof game.payoffs !== 'object' || Array.isArray(game.payoffs)) return false;
  const payoffs = game.payoffs as Record<string, unknown>;
  if (!PAYOFF_KEYS.every((key) => typeof payoffs[key] === 'number' && Number.isFinite(payoffs[key]))) return false;
  if (!OPTIONAL_TEXT_KEYS.every((key) => game[key] == null || typeof game[key] === 'string')) return false;
  return OPTIONAL_TERM_KEYS.every((key) => game[key] == null
    || (Array.isArray(game[key]) && (game[key] as unknown[]).every((term) => typeof term === 'string')));
}

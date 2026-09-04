/**
 * The server boundary for actor nouns returned with a regenerated scenario.
 *
 * The bank's `actorNounsOk` is the authority on whether a pair is safe to
 * colour. This helper deliberately only normalizes transport text, applies the
 * response-size caps, and removes ownership collisions before asking that
 * predicate. It must not grow a second, subtly different noun policy here.
 */
import { actorNounsOk } from './scenarioBank';
import { clampGraphemeSafe, stripUnsafeText } from './textSafety';

export interface ScenarioActorContext {
  description?: string | null;
  row1?: string | null;
  row2?: string | null;
  col1?: string | null;
  col2?: string | null;
}

export interface CleanActorNouns {
  actorA?: string[];
  actorB?: string[];
}

const norm = (value: string) => value
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .trim()
  .toLowerCase();

/** Actor nouns are display text, not markup or an unbounded model payload. */
function cleanTerm(value: string): string {
  return clampGraphemeSafe(
    stripUnsafeText(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    60,
  );
}

function cleanList(value: unknown): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((term) => typeof term === 'string')) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const term = cleanTerm(raw);
    const key = norm(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    // This is a response clamp, not a reason to discard an otherwise useful
    // scenario. `actorNounsOk` independently pins the same maximum.
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Return only an actor pair that remains safe after server normalization.
 *
 * Labels and opposing ownership are discarded before the final predicate so a
 * generated duplicate cannot make one player's phrase colour as the other.
 * Any remaining failure (notably a non-verbatim noun) drops the whole pair:
 * the bank's policy is "no nouns" rather than partly repairing model prose.
 */
export function cleanScenarioActorNouns(
  value: { actorA?: unknown; actorB?: unknown },
  context: ScenarioActorContext,
): CleanActorNouns {
  const rawA = cleanList(value.actorA);
  const rawB = cleanList(value.actorB);
  if (rawA === null || rawB === null) return {};

  const labels = new Set(
    [context.row1, context.row2, context.col1, context.col2]
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
      .map(norm),
  );
  const a = rawA.filter((term) => !labels.has(norm(term)));
  const b = rawB.filter((term) => !labels.has(norm(term)));
  const shared = new Set(a.map(norm).filter((term) => b.some((other) => norm(other) === term)));
  const actorA = a.filter((term) => !shared.has(norm(term)));
  const actorB = b.filter((term) => !shared.has(norm(term)));

  if (!actorNounsOk({ ...context, actorA, actorB })) return {};
  return {
    ...(actorA.length ? { actorA } : {}),
    ...(actorB.length ? { actorB } : {}),
  };
}

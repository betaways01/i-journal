/**
 * Nightly memory tidy: merges duplicate or overlapping facts and drops ones a newer fact replaced.
 * Conservative by construction: ids must exist, at most half the list changes per run, and nothing
 * is invented — merged text comes from the model but only for facts it was shown.
 */
import { Deps } from './types';

interface Plan {
  remove?: unknown;
  merge?: unknown;
}

function parsePlan(text: string): Plan | null {
  const body = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Plan;
  } catch {
    return null;
  }
}

export async function tidyMemory(deps: Deps, userKey: string, now = new Date()): Promise<{ removed: number; merged: number } | null> {
  const facts = deps.store.listFacts(userKey);
  if (facts.length < 6) return null;
  const byId = new Map(facts.map((f) => [f.id, f]));
  let res;
  try {
    res = await deps.model.complete({
      messages: [
        {
          role: 'system',
          content:
            'You tidy the memory list a companion keeps about one person. Higher id = newer. Return ONLY JSON: {"remove":[ids],"merge":[{"ids":[ids],"text":"one sentence"}]}. Remove a fact only if it is an exact or near duplicate, or clearly replaced by a newer fact. Merge facts that are parts of the same thing into one sentence using only what they say. Never merge an instruction with a fact. If nothing needs doing, return {"remove":[],"merge":[]}.',
        },
        { role: 'user', content: facts.map((f) => `#${f.id} [${f.kind}] ${f.text}`).join('\n') },
      ],
      toolChoice: 'none',
      maxTokens: 2048,
      temperature: 0,
      purpose: 'task',
    });
  } catch (err) {
    deps.log?.warn('memory tidy: model unavailable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const plan = parsePlan(res.text);
  if (!plan) return null;
  const touched = new Set<number>();
  const merges: Array<{ ids: number[]; text: string }> = [];
  for (const m of Array.isArray(plan.merge) ? plan.merge : []) {
    const ids = Array.isArray((m as { ids?: unknown }).ids) ? ((m as { ids: unknown[] }).ids.map(Number).filter((i) => byId.has(i) && !touched.has(i)) as number[]) : [];
    const text = String((m as { text?: unknown }).text || '').trim().slice(0, 500);
    const kinds = new Set(ids.map((i) => byId.get(i)!.kind));
    if (ids.length < 2 || !text || kinds.size !== 1) continue;
    ids.forEach((i) => touched.add(i));
    merges.push({ ids, text });
  }
  const removals = (Array.isArray(plan.remove) ? plan.remove : []).map(Number).filter((i) => byId.has(i) && !touched.has(i));
  removals.forEach((i) => touched.add(i));
  if (touched.size > Math.floor(facts.length / 2)) {
    deps.log?.warn('memory tidy: plan touched too many facts; skipped', { userKey, touched: touched.size, total: facts.length });
    return { removed: 0, merged: 0 };
  }
  for (const m of merges) {
    // Keep a fact that already says the merged text; otherwise replace the group with the new sentence.
    const keep = m.ids.find((i) => byId.get(i)!.text.trim().toLowerCase() === m.text.toLowerCase());
    const kind = byId.get(m.ids[0])!.kind;
    for (const i of m.ids) if (i !== keep) deps.store.removeFact(userKey, i);
    if (keep === undefined) deps.store.addFact(userKey, kind, m.text, now);
  }
  for (const i of removals) deps.store.removeFact(userKey, i);
  return { removed: removals.length, merged: merges.length };
}

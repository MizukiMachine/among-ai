import type { VoteRecord } from "../types";

export interface VoteModifier {
  targetId: string;
  count: number;
  sourceId?: string;
  reason?: string;
}

export interface VoteTotal {
  targetId: string;
  count: number;
}

export interface VoteResolution {
  counts: Map<string, number>;
  candidates: string[];
  eliminatedId: string | null;
  totals: VoteTotal[];
  tied: boolean;
}

export function tallyVotes(votes: VoteRecord[], modifiers: VoteModifier[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  }
  for (const modifier of modifiers) {
    counts.set(modifier.targetId, (counts.get(modifier.targetId) ?? 0) + modifier.count);
  }
  return counts;
}

export function topVoted(counts: Map<string, number>): string[] {
  if (counts.size === 0) {
    return [];
  }
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([, count]) => count === max).map(([id]) => id);
}

export function resolveVote(votes: VoteRecord[], modifiers: VoteModifier[] = []): VoteResolution {
  const counts = tallyVotes(votes, modifiers);
  const candidates = topVoted(counts);
  const tied = candidates.length > 1;
  return {
    counts,
    candidates,
    eliminatedId: candidates.length === 1 ? candidates[0] : null,
    totals: [...counts.entries()].map(([targetId, count]) => ({ targetId, count })),
    tied
  };
}

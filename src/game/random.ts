export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function sample<T>(items: T[]): T {
  if (items.length === 0) {
    throw new Error("Cannot sample from an empty array");
  }
  return items[Math.floor(Math.random() * items.length)];
}

export function weightedChance(probability: number): boolean {
  return Math.random() < probability;
}

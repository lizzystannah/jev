import { getDayKey } from './time.js';

export function matchesApiCacheKey(dayKey: string = getDayKey()): string {
  return `matches:api:v3:${dayKey}`;
}

/**
 * Isola cada avaliação num clone profundo. O motor pode assim ser chamado
 * repetidamente sem que uma avaliação contamine outra (B8/B4), e nenhum
 * objeto partilhado (match, odds, scout) é alterado por engano.
 */
export function cloneForEvaluation<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Objetos com funções/proxies não clonáveis caem no fallback JSON.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export function withEvaluation<T extends object, R>(
  input: T,
  evaluate: (draft: T) => R
): R {
  return evaluate(cloneForEvaluation(input));
}

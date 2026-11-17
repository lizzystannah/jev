/**
 * Mutex por chave: serializa operações críticas (geração de fichas) mesmo
 * quando chamadas por caminhos diferentes (rotas HTTP, scheduler, progressões).
 *
 * [Mutex] O chamador nunca fica pendurado para sempre: se a operação presa
 * demorar mais do que o tecto, o chamador recebe um erro (e a cadeia
 * continua à espera da operação real, para não gerar em paralelo).
 */

/** Tecto por omissão de uma operação sob o mutex (ms). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  public run<T>(key: string, fn: () => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Mantém a cadeia viva mas não deixa rejeições não tratadas.
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    if (!timeoutMs || timeoutMs <= 0) return next;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`[mutex] ${key}: timeout de ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
    });
    return Promise.race([next, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }
}

/** Instância única para a geração de fichas em todo o processo. */
export const generationMutex = new KeyedMutex();

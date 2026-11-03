/**
 * Mutex por chave: serializa operações críticas (geração de fichas) mesmo
 * quando chamadas por caminhos diferentes (rotas HTTP, scheduler, progressões).
 */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  public run<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
    return next;
  }
}

/** Instância única para a geração de fichas em todo o processo. */
export const generationMutex = new KeyedMutex();

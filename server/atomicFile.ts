/**
 * Escrita atómica de JSON.
 *
 * `writeFileSync` direto deixa o ficheiro truncado se o processo morrer a
 * meio, e bloqueia o event loop com ficheiros de dezenas de MB. Escreve-se
 * para um temporário e renomeia-se (renomeio é atómico no mesmo volume).
 */
import { writeFile, rename } from 'fs/promises';
import fs from 'fs';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * No Windows o `rename` por cima do destino falha com EPERM/EBUSY quando um
 * antivírus ou o indexador tem o ficheiro aberto. Retry curto resolve.
 */
async function renameWithRetry(tmp: string, file: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      await sleep(50 * (i + 1));
    }
  }
  throw lastErr;
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf-8');
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temporário órfão: ignorado */
    }
    throw err;
  }
}

/** Só para o handler de 'exit' (não pode ser async). */
export function writeJsonAtomicSync(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (err: any) {
    const code = err?.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      try {
        fs.unlinkSync(file);
        fs.renameSync(tmp, file);
        return;
      } catch {
        /* cai para o erro original */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignorado */
    }
    throw err;
  }
}

/**
 * Ponte única para chamar os bridges Python.
 *
 * Motivo: `aiscoreService` e `premierbetOdds` duplicavam a resolução do
 * interpretador e o `execFile`, e o segundo não tinha `windowsHide`, nem
 * serialização, nem limite de output. O payload ia em `argv` — no Windows o
 * limite da linha de comandos é ~32 KB e 80 pernas × 14 mercados já passam
 * disso. Passa agora por stdin.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface PythonRunOptions {
  cwd: string;
  timeoutMs: number;
  maxBytes?: number;
  /** Bytes de stderr a incluir na mensagem de erro. */
  stderrTail?: number;
}

export function resolvePythonBin(envNames: string[], roots: string[]): string {
  for (const n of envNames) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  for (const r of roots) {
    for (const rel of [
      ['.venv312', 'Scripts', 'python.exe'],
      ['.venv', 'Scripts', 'python.exe'],
      ['.venv312', 'bin', 'python'],
      ['.venv', 'bin', 'python'],
    ]) {
      const c = path.join(r, ...rel);
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* tenta o seguinte */
      }
    }
  }
  return 'python3';
}

/**
 * Executa o script e devolve o JSON do stdout.
 * Lê o stdout mesmo com exit code != 0 (o bridge devolve `{"ok":false,...}`).
 */
export function runPythonJson<T>(
  bin: string,
  script: string,
  payload: unknown,
  opts: PythonRunOptions
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['-X', 'utf8', script, '--stdin'], {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const max = opts.maxBytes ?? 16 * 1024 * 1024;
    const stderrTail = opts.stderrTail ?? 400;
    let out = '';
    let err = '';
    let timedOut = false;
    let overflow = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      if (out.length > max) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (d: string) => {
      err += d;
      if (err.length > 64 * 1024) err = err.slice(-64 * 1024);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (text) {
        try {
          resolve(JSON.parse(text) as T);
          return;
        } catch {
          /* continua para o erro abaixo */
        }
      }
      if (overflow) {
        reject(new Error(`saída do bridge acima de ${max} bytes`));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout ${opts.timeoutMs}ms`));
        return;
      }
      reject(
        new Error(
          `exit ${code}: ${err.trim().slice(-stderrTail) || 'sem output'}` +
            (text ? ` (stdout inválido: ${text.slice(0, 200)})` : '')
        )
      );
    });

    // Payload por stdin (evita o limite de ~32 KB do argv no Windows).
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* o processo pode já ter terminado */
    }
  });
}

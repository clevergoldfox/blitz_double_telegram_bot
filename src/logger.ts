import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Logger minimo e sem dependencia. Aceita as duas formas de chamada:
 *   log.info('mensagem')
 *   log.info({ chave: valor }, 'mensagem')
 *
 * Grava uma linha legivel no console e, opcionalmente, JSON por linha em
 * arquivo, que e o formato que presta para investigar incidente depois.
 */
export function createLogger(opts: {
  level: Level;
  file?: string;
  bindings?: Record<string, unknown>;
}): Logger {
  const { level, file } = opts;
  const bindings = opts.bindings ?? {};

  if (file) mkdirSync(dirname(file), { recursive: true });

  const emit = (lvl: Level, obj: unknown, msg?: string): void => {
    if (ORDER[lvl] < ORDER[level]) return;

    let text: string;
    let fields: Record<string, unknown>;
    if (typeof obj === 'string') {
      text = obj;
      fields = {};
    } else {
      text = msg ?? '';
      fields = (obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : { valor: obj });
    }

    const all = { ...bindings, ...fields };
    const ts = new Date().toISOString();
    const extra = Object.keys(all).length ? ' ' + JSON.stringify(all) : '';
    const line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${text}${extra}`;

    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);

    if (file) {
      try {
        appendFileSync(file, JSON.stringify({ ts, level: lvl, msg: text, ...all }) + '\n');
      } catch {
        // Nunca deixar falha de log derrubar o robo.
      }
    }
  };

  return {
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
    child: (b) => createLogger({ level, file, bindings: { ...bindings, ...b } }),
  };
}

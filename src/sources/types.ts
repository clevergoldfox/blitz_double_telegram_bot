import { EventEmitter } from 'node:events';
import { GameResult } from '../types';

export type SourceMode = 'ws' | 'rest' | 'sim';

export interface SourceStatus {
  mode: SourceMode;
  connected: boolean;
  lastResultAt: string | null;
  /** Latencia entre o fechamento do round na plataforma e a chegada aqui. */
  lastLatencyMs: number | null;
  reconnects: number;
  detail: string;
}

/**
 * Uma fonte de resultados do Double.
 *
 * Toda a incerteza sobre a plataforma fica atras desta interface: trocar de
 * WebSocket para polling, ou da Blitz para outra casa, nao toca no motor nem no
 * bot. Emite:
 *   'result' (GameResult)  - round confirmado
 *   'gap'    (string)      - pode ter perdido rounds; o motor desarma por seguranca
 *   'status' (SourceStatus)
 */
export abstract class ResultSource extends EventEmitter {
  abstract readonly mode: SourceMode;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract status(): SourceStatus;

  protected emitResult(r: GameResult): void {
    this.emit('result', r);
  }

  protected emitGap(reason: string): void {
    this.emit('gap', reason);
  }

  onResult(cb: (r: GameResult) => void): this {
    this.on('result', cb);
    return this;
  }

  onGap(cb: (reason: string) => void): this {
    this.on('gap', cb);
    return this;
  }
}

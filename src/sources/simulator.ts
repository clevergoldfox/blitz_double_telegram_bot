import { randomUUID } from 'node:crypto';
import { Color, GameResult } from '../types';
import { ResultSource, SourceMode, SourceStatus } from './types';

/**
 * Roleta local, com a mesma composicao do Double: 15 casas, sendo
 * 7 pretas, 7 amarelas e 1 branca.
 *
 * Serve para dois propositos reais:
 *  - demonstrar e testar o robo inteiro de ponta a ponta sem depender da Blitz
 *  - gerar historico para exercitar o backtest
 *
 * Nao e previsao de nada: cada giro e independente, exatamente como a roleta.
 */
export class SimulatorSource extends ResultSource {
  readonly mode: SourceMode = 'sim';

  private timer: NodeJS.Timeout | null = null;
  private lastResultAt: string | null = null;
  private running = false;

  static readonly SLOTS = 15;

  /** 0 = branco, 1..7 = amarelo, 8..14 = preto (layout da familia Blaze). */
  static colorForRoll(roll: number): Color {
    if (roll === 0) return 'B';
    return roll <= 7 ? 'A' : 'P';
  }

  constructor(
    private intervalMs: number,
    /** Sequencia fixa de cores para reproduzir um cenario; vazio = aleatorio. */
    private scripted: Color[] = [],
  ) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;
    let i = 0;
    const tick = () => {
      if (!this.running) return;
      let color: Color;
      let roll: number | null;
      if (this.scripted.length > 0) {
        color = this.scripted[i % this.scripted.length];
        i++;
        roll = null;
      } else {
        roll = Math.floor(Math.random() * 15);
        color = SimulatorSource.colorForRoll(roll);
      }
      const now = new Date().toISOString();
      this.lastResultAt = now;
      this.emitResult({ roundId: randomUUID(), color, roll, createdAt: now, live: true });
    };
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SourceStatus {
    return {
      mode: 'sim',
      connected: this.running,
      lastResultAt: this.lastResultAt,
      lastLatencyMs: 0,
      reconnects: 0,
      detail: `simulador local, 1 giro a cada ${Math.round(this.intervalMs / 1000)}s`,
    };
  }
}

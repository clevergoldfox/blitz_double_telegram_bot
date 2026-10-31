import { Api, GrammyError } from 'grammy';
import { Logger } from '../logger';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fila serial de envio para o Telegram.
 *
 * Existe por dois motivos concretos:
 *  - quando varios padroes confirmam na mesma rodada, sai uma rajada de
 *    mensagens e o Telegram comeca a responder 429;
 *  - um alerta perdido por erro transitorio e justamente o que o cliente
 *    percebe, entao cada mensagem tem direito a nova tentativa.
 */
export class Notifier {
  private queue: string[] = [];
  private draining = false;

  constructor(
    private api: Api,
    private chatId: string,
    private log: Logger,
    private minGapMs = 350,
    private maxAttempts = 4,
  ) {}

  /** Enfileira e retorna na hora: o motor nunca espera pela rede. */
  send(text: string): void {
    this.queue.push(text);
    void this.drain();
  }

  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift()!;
        await this.deliver(text);
        if (this.queue.length > 0) await sleep(this.minGapMs);
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(text: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.api.sendMessage(this.chatId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 429) {
          const wait = (err.parameters?.retry_after ?? 2) * 1000;
          this.log.warn({ wait, attempt }, 'telegram pediu para esperar (429)');
          await sleep(wait);
          continue;
        }
        // 400 normalmente e HTML malformado: tentar de novo nao resolve.
        if (err instanceof GrammyError && err.error_code === 400) {
          this.log.error({ err: err.description }, 'telegram recusou a mensagem; reenviando sem formatacao');
          try {
            await this.api.sendMessage(this.chatId, stripHtml(text));
            return;
          } catch (err2) {
            this.log.error({ err: String(err2) }, 'falhou tambem sem formatacao; mensagem descartada');
            return;
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ err: msg, attempt }, 'falha ao enviar no Telegram');
        if (attempt === this.maxAttempts) {
          this.log.error({ err: msg }, 'desisti de enviar esta mensagem');
          return;
        }
        await sleep(attempt * 1000);
      }
    }
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

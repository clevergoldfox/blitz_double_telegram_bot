import WebSocket from 'ws';
import { Color, GameResult } from '../types';
import { ResultSource, SourceMode, SourceStatus } from './types';
import { extractRounds, FieldMap, inflateSocketPayload, unwrapSocketFrame } from './parsing';
import { Logger } from '../logger';

export interface BlitzConfig {
  /** WebSocket de resultados ao vivo. Sem ele, caimos em polling REST. */
  wsUrl?: string;
  /**
   * 'socketio' faz o aperto de mao do socket.io (engine.io v4) e decodifica o
   * anexo binario deflate; e o que a Blitz usa. 'raw' so escuta frames de texto.
   */
  wsProtocol: 'socketio' | 'raw';
  /** Salas assinadas apos o aperto de mao, ex. ['double_room_1']. */
  wsRooms: string[];
  /** Texto enviado ao abrir a conexao, quando wsProtocol = 'raw'. */
  wsSubscribe?: string;
  /** Endpoint de resultados recentes. Usado para backfill e como fallback. */
  restRecentUrl?: string;
  pollMs: number;
  origin?: string;
  referer?: string;
  userAgent: string;
  colorMap: Record<string, Color>;
  fields: Partial<FieldMap>;
  requireComplete: boolean;
  /** Sem nenhum resultado por este tempo, reconecta por conta propria. */
  staleAfterMs: number;
  backfillLimit: number;
}

const MAX_BACKOFF_MS = 30_000;

export class BlitzSource extends ResultSource {
  readonly mode: SourceMode;

  private ws: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /**
   * Ping iniciado por nos.
   *
   * Medido contra o servidor da Blitz: ele anuncia pingInterval 25s /
   * pingTimeout 20s no aperto de mao mas NUNCA envia o ping dele. Quem nao
   * manda '2' sozinho leva desconexao em ~46s (25+20). Com o ping do cliente a
   * conexao fica de pe indefinidamente.
   */
  private pingTimer: NodeJS.Timeout | null = null;
  /** Evita assinar a mesma sala duas vezes: o servidor manda '40' repetido. */
  private subscribed = false;
  private backoffMs = 1_000;
  private reconnects = 0;
  private connected = false;
  private stopping = false;
  private detail = 'nao iniciado';

  private lastResultAt: string | null = null;
  private lastLatencyMs: number | null = null;
  private lastRoundId: string | null = null;
  private lastRoundCreatedAt: string | null = null;

  /** Ids recentes, para nao reemitir o mesmo round. */
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(private cfg: BlitzConfig, private log: Logger) {
    super();
    this.mode = cfg.wsUrl ? 'ws' : 'rest';
  }

  async start(): Promise<void> {
    this.stopping = false;
    // Backfill antes de qualquer coisa: o historico precisa estar o mais
    // completo possivel antes do motor comecar a avaliar gatilhos.
    if (this.cfg.restRecentUrl) await this.backfill('inicializacao');

    if (this.cfg.wsUrl) this.connectWs();
    else this.startPolling();

    this.watchdog = setInterval(() => this.checkStale(), Math.max(5_000, this.cfg.staleAfterMs / 2));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopClientPing();
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watchdog = null;
    this.pollTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ja fechado */ }
      this.ws = null;
    }
    this.connected = false;
  }

  status(): SourceStatus {
    return {
      mode: this.mode,
      connected: this.connected,
      lastResultAt: this.lastResultAt,
      lastLatencyMs: this.lastLatencyMs,
      reconnects: this.reconnects,
      detail: this.detail,
    };
  }

  // ----- WebSocket -----

  private connectWs(): void {
    if (this.stopping || !this.cfg.wsUrl) return;
    this.detail = `conectando em ${this.cfg.wsUrl}`;
    this.log.info({ url: this.cfg.wsUrl }, 'coletor: conectando no WebSocket');

    const headers: Record<string, string> = { 'User-Agent': this.cfg.userAgent };
    if (this.cfg.origin) headers.Origin = this.cfg.origin;
    if (this.cfg.referer) headers.Referer = this.cfg.referer;

    const ws = new WebSocket(this.cfg.wsUrl, { headers, handshakeTimeout: 15_000 });
    this.ws = ws;
    this.subscribed = false;

    ws.on('open', () => {
      this.connected = true;
      this.backoffMs = 1_000;
      this.detail = 'WebSocket conectado';
      this.log.info('coletor: WebSocket conectado');
      // No socket.io, a assinatura so vale depois do aperto de mao; quem envia
      // e handleData ao receber o '0{...}' e o '40'.
      if (this.cfg.wsProtocol === 'raw' && this.cfg.wsSubscribe) ws.send(this.cfg.wsSubscribe);
      // Reconectou: pode ter perdido rounds enquanto estava fora.
      if (this.reconnects > 0 && this.cfg.restRecentUrl) {
        void this.backfill('reconexao');
      }
    });

    ws.on('message', (data: WebSocket.RawData) => this.handleData(data));

    ws.on('close', (code) => {
      this.connected = false;
      this.stopClientPing();
      this.subscribed = false;
      if (this.stopping) return;
      this.detail = `WebSocket caiu (codigo ${code})`;
      this.log.warn({ code }, 'coletor: WebSocket fechou, vai reconectar');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.connected = false;
      this.detail = `erro no WebSocket: ${err.message}`;
      this.log.error({ err: err.message }, 'coletor: erro no WebSocket');
      // 'close' vem depois de 'error' e e la que reagendamos.
    });

    ws.on('ping', () => ws.pong());
  }

  private handleData(data: WebSocket.RawData): void {
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    const text = buf.toString('utf8');

    // engine.io: '2' e ping do servidor, responde '3' ou a conexao cai.
    if (text === '2') {
      this.ws?.send('3');
      return;
    }
    if (text === '3') return;

    if (this.cfg.wsProtocol === 'socketio') {
      // '0{...}' = handshake do engine.io -> conecta no namespace padrao
      if (text.startsWith('0{')) {
        this.ws?.send('40');
        this.startClientPing(text);
        return;
      }
      // '40' = namespace aceito -> agora sim da para assinar as salas
      if (text.startsWith('40')) {
        this.subscribeRooms();
        return;
      }
      // anexo binario (deflate cru) com o conteudo de verdade
      if (buf[0] === 0x04) {
        const msg = inflateSocketPayload(buf);
        if (msg !== null) this.ingest(msg);
        return;
      }
    }

    const payload = unwrapSocketFrame(text);
    if (payload !== null) this.ingest(payload);
  }

  /**
   * Liga o ping do cliente usando o pingInterval anunciado no aperto de mao,
   * com folga de 5s. Sem isso o servidor da Blitz derruba a conexao em ~46s.
   */
  private startClientPing(handshake: string): void {
    this.stopClientPing();
    let interval = 25_000;
    try {
      const cfg = JSON.parse(handshake.slice(1)) as { pingInterval?: number };
      if (typeof cfg.pingInterval === 'number' && cfg.pingInterval > 0) interval = cfg.pingInterval;
    } catch {
      // mantem o padrao
    }
    const every = Math.max(5_000, interval - 5_000);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('2');
    }, every);
    this.log.info({ every }, 'coletor: ping do cliente ativado');
  }

  private stopClientPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private subscribeRooms(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const rooms = this.cfg.wsRooms.length > 0 ? this.cfg.wsRooms : ['double_room_1'];
    for (const room of rooms) {
      const frame = `420["cmd",${JSON.stringify({ id: 'subscribe', payload: { room } })}]`;
      this.ws?.send(frame);
      this.log.info({ room }, 'coletor: sala assinada');
    }
    this.detail = `WebSocket conectado, salas: ${rooms.join(', ')}`;
  }

  private ingest(payload: unknown): void {
    const rounds = extractRounds(payload, {
      fields: this.cfg.fields,
      colorMap: this.cfg.colorMap,
      requireComplete: this.cfg.requireComplete,
    });
    for (const r of rounds) this.publish(r);
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnects++;
    const jitter = Math.floor(Math.random() * 500);
    const wait = Math.min(this.backoffMs, MAX_BACKOFF_MS) + jitter;
    this.log.info({ wait }, 'coletor: reconectando');
    setTimeout(() => this.connectWs(), wait);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  // ----- REST -----

  private startPolling(): void {
    if (!this.cfg.restRecentUrl) {
      this.detail = 'sem WS e sem REST configurados: coletor inativo';
      this.log.error(this.detail);
      return;
    }
    this.detail = `polling REST a cada ${this.cfg.pollMs}ms`;
    this.connected = true;
    const tick = () => void this.poll();
    this.pollTimer = setInterval(tick, this.cfg.pollMs);
    tick();
  }

  private async poll(): Promise<void> {
    const rounds = await this.fetchRecent();
    if (rounds === null) return;
    for (const r of rounds) this.publish(r);
  }

  private async fetchRecent(): Promise<GameResult[] | null> {
    if (!this.cfg.restRecentUrl) return null;
    try {
      const headers: Record<string, string> = {
        'User-Agent': this.cfg.userAgent,
        Accept: 'application/json, text/plain, */*',
      };
      if (this.cfg.origin) headers.Origin = this.cfg.origin;
      if (this.cfg.referer) headers.Referer = this.cfg.referer;

      const res = await fetch(this.cfg.restRecentUrl, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        this.detail = `REST respondeu HTTP ${res.status}`;
        this.log.warn({ status: res.status }, 'coletor: REST nao OK');
        return null;
      }
      const json = await res.json();
      return extractRounds(json, {
        fields: this.cfg.fields,
        colorMap: this.cfg.colorMap,
        requireComplete: this.cfg.requireComplete,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.detail = `falha no REST: ${msg}`;
      this.log.warn({ err: msg }, 'coletor: falha ao buscar REST');
      return null;
    }
  }

  /**
   * Preenche o historico pelo endpoint REST e decide se sobrou buraco.
   *
   * Um buraco silencioso e o defeito mais perigoso deste sistema: o robo
   * continuaria emitindo sinais, mas casando padroes contra um historico
   * furado. Por isso, quando nao conseguimos provar continuidade, avisamos o
   * motor para desarmar ate reconstruir a janela.
   */
  private async backfill(reason: string): Promise<void> {
    const rounds = await this.fetchRecent();
    if (rounds === null || rounds.length === 0) {
      if (this.lastRoundId !== null) this.emitGap(`${reason}: nao foi possivel conferir o historico`);
      return;
    }

    const oldest = rounds[0].createdAt;
    const bridged =
      this.lastRoundId === null ||
      rounds.some((r) => r.roundId === this.lastRoundId) ||
      (this.lastRoundCreatedAt !== null && oldest <= this.lastRoundCreatedAt);

    for (const r of rounds) this.publish({ ...r, live: false });

    if (!bridged) {
      this.emitGap(
        `${reason}: a janela do historico nao alcanca o ultimo round conhecido, pode ter rodada perdida`,
      );
    }
    this.log.info({ reason, trazidos: rounds.length, bridged }, 'coletor: backfill concluido');
  }

  private checkStale(): void {
    if (!this.lastResultAt) return;
    const age = Date.now() - new Date(this.lastResultAt).getTime();
    if (age < this.cfg.staleAfterMs) return;

    this.log.warn({ ageMs: age }, 'coletor: sem resultado por tempo demais, forcando reconexao');
    this.detail = `sem resultado por ${Math.round(age / 1000)}s`;
    if (this.mode === 'ws') {
      try { this.ws?.close(); } catch { /* o handler de close reagenda */ }
    } else {
      void this.backfill('silencio prolongado');
    }
  }

  private publish(r: GameResult): void {
    if (this.seen.has(r.roundId)) return;
    this.seen.add(r.roundId);
    this.seenOrder.push(r.roundId);
    if (this.seenOrder.length > 500) {
      const drop = this.seenOrder.shift();
      if (drop) this.seen.delete(drop);
    }

    this.lastResultAt = new Date().toISOString();
    // A rodada da Blitz abre as apostas em created_at e so revela a cor ~15s
    // depois, em updated_at. Medir o atraso contra created_at daria uns 15s e
    // faria o robo parecer lento; o numero que importa e quanto tempo passou
    // desde a revelacao.
    const referencia = r.revealedAt ?? r.createdAt;
    this.lastLatencyMs = Math.max(0, Date.now() - new Date(referencia).getTime());
    this.lastRoundId = r.roundId;
    this.lastRoundCreatedAt = r.createdAt;
    this.emitResult(r);
  }
}

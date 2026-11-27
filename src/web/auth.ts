import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Db, getMeta, setMeta } from '../db/index';

const COOKIE = 'painel';
const DIAS = 14;

/**
 * Sessao do painel.
 *
 * E um operador so, entao nao ha tabela de usuarios: uma senha no .env, um
 * cookie assinado, e pronto. O segredo da assinatura fica no banco e nao no
 * .env de proposito — assim a sessao sobrevive a um restart do servico, que e
 * o que o cliente vai sentir quando eu subir uma correcao.
 */
export class Auth {
  /** Erros de senha tolerados antes de comecar a atrasar a resposta. */
  static readonly TENTATIVAS_LIVRES = 3;

  private readonly secret: Buffer;
  private readonly salt: Buffer;
  private readonly hash: Buffer;
  /** Tentativas erradas por IP, para o login nao virar alvo de forca bruta. */
  private readonly falhas = new Map<string, { n: number; ate: number }>();

  constructor(db: Db, senha: string) {
    let guardado = getMeta(db, 'web_session_secret');
    if (!guardado) {
      guardado = randomBytes(32).toString('hex');
      setMeta(db, 'web_session_secret', guardado);
    }
    this.secret = Buffer.from(guardado, 'hex');

    // A senha vive em memoria so como hash: um dump de heap nao entrega o .env.
    this.salt = randomBytes(16);
    this.hash = scryptSync(senha, this.salt, 32);
  }

  /** Quanto falta de castigo para este IP, em segundos (0 = pode tentar). */
  esperaDe(ip: string): number {
    const f = this.falhas.get(ip);
    if (!f) return 0;
    const resta = f.ate - Date.now();
    return resta > 0 ? Math.ceil(resta / 1000) : 0;
  }

  confere(ip: string, senha: string): boolean {
    const tentativa = scryptSync(senha, this.salt, 32);
    const ok = timingSafeEqual(tentativa, this.hash);

    if (ok) {
      this.falhas.delete(ip);
      return true;
    }

    // Errar a senha de dedo e normal, entao as primeiras tentativas saem de
    // graca. A partir dai a espera dobra (1s, 2s, 4s...) ate o teto de 5min,
    // o que inviabiliza forca bruta sem incomodar quem so digitou errado.
    const f = this.falhas.get(ip) ?? { n: 0, ate: 0 };
    f.n++;
    const castigo = f.n <= Auth.TENTATIVAS_LIVRES
      ? 0
      : Math.min(300_000, 2 ** (f.n - Auth.TENTATIVAS_LIVRES - 1) * 1000);
    f.ate = Date.now() + castigo;
    this.falhas.set(ip, f);
    return false;
  }

  private assina(corpo: string): string {
    return createHmac('sha256', this.secret).update(corpo).digest('base64url');
  }

  criaToken(): string {
    const corpo = String(Date.now() + DIAS * 86_400_000);
    return `${corpo}.${this.assina(corpo)}`;
  }

  tokenValido(token: string | undefined): boolean {
    if (!token) return false;
    const corte = token.lastIndexOf('.');
    if (corte <= 0) return false;

    const corpo = token.slice(0, corte);
    const assinatura = token.slice(corte + 1);
    const esperada = this.assina(corpo);

    // Comprimentos diferentes fazem timingSafeEqual estourar, entao conferimos antes.
    if (assinatura.length !== esperada.length) return false;
    if (!timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada))) return false;

    const expira = Number(corpo);
    return Number.isFinite(expira) && Date.now() < expira;
  }

  cookieDeLogin(token: string, seguro: boolean): string {
    const partes = [
      `${COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${DIAS * 86_400}`,
    ];
    if (seguro) partes.push('Secure');
    return partes.join('; ');
  }

  cookieDeSaida(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  leCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;
    for (const parte of header.split(';')) {
      const [k, ...resto] = parte.trim().split('=');
      if (k === COOKIE) return resto.join('=');
    }
    return undefined;
  }
}

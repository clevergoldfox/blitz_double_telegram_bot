/**
 * Ferramenta de descoberta do feed.
 *
 * Nao existe API publica documentada da Blitz, e o endereco real so se confirma
 * de dentro de um IP brasileiro. Este script faz esse reconhecimento sozinho:
 *
 *   node dist/src/probe.js https://<site>/games/double
 *
 * Ele busca a pagina, varre o HTML e os bundles de JS procurando candidatos de
 * REST e WebSocket, testa cada um, e imprime as linhas de .env que servem.
 *
 * Rode sempre no servidor onde o robo vai ficar (de preferencia no Brasil):
 * o resultado depende do IP de saida.
 */
import WebSocket from 'ws';
import { extractRounds, inflateSocketPayload, unwrapSocketFrame } from './sources/parsing';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Caminhos REST usados pelas casas da familia Blaze. Tentamos todos. */
const REST_GUESSES = [
  '/api/roulette_games/recent',
  '/api/roulette_games/current',
  '/api/double/recent',
  '/api/doubles/recent',
  '/api/games/double/recent',
  '/api/v1/roulette_games/recent',
  '/api/v2/roulette_games/recent',
];

/** Salas tentadas na assinatura. A Blitz usa double_room_1..10. */
const ROOM_GUESSES = ['double_room_1', 'double_room_2', 'doubles', 'double'];

const WS_GUESSES = (host: string) => [
  // binary=1 e obrigatorio na Blitz: sem isso o servidor responde
  // 44"Binary replication required" e fecha.
  `wss://api-gaming.${host}/replication/?EIO=4&transport=websocket&binary=1`,
  `wss://api-gaming.${host}/replication/?EIO=4&transport=websocket`,
  `wss://api-gaming.${host}/replication/?EIO=3&transport=websocket`,
  `wss://ws.${host}/socket.io/?EIO=4&transport=websocket`,
  `wss://${host}/socket.io/?EIO=4&transport=websocket`,
];

interface Finding {
  url: string;
  kind: 'rest' | 'ws';
  ok: boolean;
  detail: string;
  rounds: number;
  sample?: unknown;
}

const headers = (origin?: string): Record<string, string> => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  ...(origin ? { Origin: origin, Referer: origin + '/' } : {}),
});

async function fetchText(url: string, origin?: string): Promise<{ status: number; body: string; server: string }> {
  const res = await fetch(url, { headers: headers(origin), signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  const body = await res.text();
  return { status: res.status, body, server: res.headers.get('server') ?? '' };
}

/** Procura no texto tudo que pareca endpoint de API ou WebSocket. */
function harvestUrls(text: string): { ws: string[]; api: string[]; assets: string[] } {
  const ws = new Set<string>();
  const api = new Set<string>();
  const assets = new Set<string>();

  for (const m of text.matchAll(/wss?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+/g)) {
    if (m[0].startsWith('ws')) ws.add(m[0].replace(/["'\\]+$/, ''));
  }
  for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*api[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*/gi)) {
    api.add(m[0].replace(/["'\\]+$/, ''));
  }
  for (const m of text.matchAll(/["'](\/[A-Za-z0-9._/-]*(?:roulette|double|game)[A-Za-z0-9._/-]*)["']/gi)) {
    api.add(m[1]);
  }
  for (const m of text.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/gi)) {
    assets.add(m[1]);
  }
  return { ws: [...ws], api: [...api], assets: [...assets] };
}

async function probeRest(url: string, origin?: string): Promise<Finding> {
  try {
    const { status, body } = await fetchText(url, origin);
    if (status !== 200) {
      return { url, kind: 'rest', ok: false, detail: `HTTP ${status}`, rounds: 0 };
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { url, kind: 'rest', ok: false, detail: 'resposta nao e JSON', rounds: 0 };
    }
    const rounds = extractRounds(json, { requireComplete: false });
    return {
      url,
      kind: 'rest',
      ok: rounds.length > 0,
      detail: rounds.length > 0 ? `${rounds.length} rodadas reconhecidas` : 'JSON ok, mas sem rodada reconhecivel',
      rounds: rounds.length,
      sample: rounds[rounds.length - 1] ?? (Array.isArray(json) ? json[0] : json),
    };
  } catch (err) {
    return { url, kind: 'rest', ok: false, detail: err instanceof Error ? err.message : String(err), rounds: 0 };
  }
}

async function probeWs(url: string, origin: string | undefined, seconds: number): Promise<Finding> {
  return new Promise((resolve) => {
    let rounds = 0;
    let frames = 0;
    let sample: unknown;
    let settled = false;

    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({ url, kind: 'ws', ok, detail, rounds, sample });
    };

    const ws = new WebSocket(url, {
      headers: { 'User-Agent': UA, ...(origin ? { Origin: origin } : {}) },
      handshakeTimeout: 12_000,
    });

    const timer = setTimeout(
      () => done(rounds > 0, `${frames} frames, ${rounds} rodadas em ${seconds}s`),
      seconds * 1000,
    );

    let subscribed = false;
    let pingTimer: NodeJS.Timeout | null = null;

    ws.on('message', (data) => {
      frames++;
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      const raw = buf.toString('utf8');

      // Aperto de mao do engine.io v4. O servidor da Blitz anuncia pingInterval
      // mas nao envia ping nenhum: quem nao pingar sozinho cai em ~46s.
      if (raw.startsWith('0{')) {
        ws.send('40');
        try {
          const cfg = JSON.parse(raw.slice(1)) as { pingInterval?: number };
          const every = Math.max(5_000, (cfg.pingInterval ?? 25_000) - 5_000);
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('2');
          }, every);
        } catch { /* usa o padrao */ }
        return;
      }
      if (raw.startsWith('40') && !subscribed) {
        subscribed = true;
        // Formato visto na Blitz: emit("cmd", {id:"subscribe", payload:{room}})
        for (const room of ROOM_GUESSES) {
          ws.send(`420["cmd",${JSON.stringify({ id: 'subscribe', payload: { room } })}]`);
        }
        return;
      }
      if (raw === '2') { ws.send('3'); return; }
      if (raw === '3') return;

      // Anexo binario (deflate cru) usado pelo modo "binary replication".
      const payload = buf[0] === 0x04 ? inflateSocketPayload(buf) : unwrapSocketFrame(raw);
      if (payload === null) return;
      const found = extractRounds(payload, { requireComplete: false });
      if (found.length > 0) {
        rounds += found.length;
        sample ??= found[0];
      }
    });

    const clearPing = () => { if (pingTimer) clearInterval(pingTimer); pingTimer = null; };
    ws.once('close', clearPing);
    ws.once('error', clearPing);

    ws.on('error', (err) => { clearTimeout(timer); done(false, err.message); });
    ws.on('close', () => { clearTimeout(timer); done(rounds > 0, `fechou apos ${frames} frames, ${rounds} rodadas`); });
  });
}

async function main(): Promise<void> {
  const target = process.argv[2];
  const wsSeconds = Number(process.argv[3] ?? 45);

  if (!target) {
    console.log('uso: node dist/src/probe.js <url da pagina do Double> [segundos de escuta do WS]');
    console.log('exemplo: node dist/src/probe.js https://exemplo.bet.br/games/double 60');
    process.exit(1);
  }

  const u = new URL(target);
  const origin = u.origin;
  const host = u.hostname.replace(/^www\./, '');

  console.log('='.repeat(70));
  console.log('RECONHECIMENTO DO FEED');
  console.log('alvo  :', target);
  console.log('origem:', origin);
  console.log('ATENCAO: rode isto no servidor onde o robo vai ficar. Casas');
  console.log('brasileiras costumam bloquear IP de fora do Brasil.');
  console.log('='.repeat(70));

  // 1. a pagina abre?
  console.log('\n[1] buscando a pagina...');
  let html = '';
  try {
    const r = await fetchText(target);
    html = r.body;
    console.log(`    HTTP ${r.status}${r.server ? ` (server: ${r.server})` : ''}, ${html.length} bytes`);
    if (r.status === 403 || /cf-browser-verification|Just a moment|cf_chl/i.test(html)) {
      console.log('    !! Cloudflare barrou o acesso.');
      console.log('       Opcoes: rodar de um IP brasileiro, ou coletar via navegador headless.');
    }
    if (/geo|regi(a|\u00E3)o|not available in your country/i.test(html.slice(0, 4000))) {
      console.log('    !! a pagina menciona restricao geografica.');
    }
  } catch (err) {
    console.log('    falhou:', err instanceof Error ? err.message : err);
  }

  // 2. candidatos no HTML e nos bundles
  console.log('\n[2] procurando candidatos no HTML e nos bundles de JS...');
  const harvested = harvestUrls(html);
  const assets = harvested.assets.slice(0, 8);
  for (const a of assets) {
    const assetUrl = a.startsWith('http') ? a : origin + (a.startsWith('/') ? a : '/' + a);
    try {
      const r = await fetchText(assetUrl, origin);
      const more = harvestUrls(r.body);
      harvested.ws.push(...more.ws);
      harvested.api.push(...more.api);
    } catch { /* bundle inacessivel, segue */ }
  }
  const wsCandidates = [...new Set([...harvested.ws, ...WS_GUESSES(host)])];
  const apiFromSite = [...new Set(harvested.api)]
    .map((p) => (p.startsWith('http') ? p : origin + p))
    .filter((p) => /roulette|double|game|recent/i.test(p));
  const restCandidates = [...new Set([...apiFromSite, ...REST_GUESSES.map((p) => origin + p)])];

  console.log(`    ${restCandidates.length} candidatos REST, ${wsCandidates.length} candidatos WS`);

  // 3. testa REST
  console.log('\n[3] testando candidatos REST...');
  const restFindings: Finding[] = [];
  for (const url of restCandidates.slice(0, 25)) {
    const f = await probeRest(url, origin);
    restFindings.push(f);
    console.log(`    ${f.ok ? 'OK  ' : '--  '} ${url}  ${f.detail}`);
  }

  // 4. testa WS
  console.log(`\n[4] testando candidatos WS (${wsSeconds}s cada, ate achar um)...`);
  const wsFindings: Finding[] = [];
  for (const url of wsCandidates.slice(0, 6)) {
    process.stdout.write(`    ouvindo ${url} ... `);
    const f = await probeWs(url, origin, wsSeconds);
    wsFindings.push(f);
    console.log(`${f.ok ? 'OK' : '--'} ${f.detail}`);
    if (f.ok) break;
  }

  // 5. conclusao
  const bestRest = restFindings.filter((f) => f.ok).sort((a, b) => b.rounds - a.rounds)[0];
  const bestWs = wsFindings.find((f) => f.ok);

  console.log('\n' + '='.repeat(70));
  console.log('RESULTADO');
  console.log('='.repeat(70));

  if (!bestRest && !bestWs) {
    console.log('\nNenhum feed acessivel deste IP.');

    // Diagnostico util: 404 significa "esse caminho nao existe"; 401/403/503
    // significa "existe, mas esta barrado para este IP". A diferenca decide se
    // o problema e de endereco ou de localizacao do servidor.
    const barrados = restFindings.filter((f) => /HTTP (401|403|429|503)/.test(f.detail));
    const inexistentes = restFindings.filter((f) => /HTTP 404/.test(f.detail));
    if (barrados.length > 0) {
      console.log('\n>> Sinal importante: estes caminhos NAO responderam 404, e sim bloqueio:');
      for (const f of barrados) console.log(`   ${f.detail.padEnd(9)} ${f.url}`);
      console.log(`   (outros ${inexistentes.length} caminhos responderam 404, ou seja, nao existem)`);
      console.log('   Ou seja: o endpoint provavelmente EXISTE e esta barrado para este IP.');
      console.log('   Rodar de um VPS no Brasil tende a resolver.');
    }
    const wsVivo = wsFindings.filter((f) => /frames/.test(f.detail) && !/^0 frames/.test(f.detail));
    if (wsVivo.length > 0) {
      console.log('\n>> O WebSocket aceitou conexao e trocou frames nestes enderecos:');
      for (const f of wsVivo) console.log(`   ${f.url}\n      ${f.detail}`);
      console.log('   O host existe. Falta a mensagem de subscribe correta, que se');
      console.log('   descobre na aba Rede do navegador (filtro WS, primeira mensagem enviada),');
      console.log('   e depois vai em BLITZ_WS_SUBSCRIBE.');
    }

    console.log('\nProximos passos, em ordem:');
    console.log('  1. rodar este mesmo comando de um VPS no Brasil;');
    console.log('  2. abrir a pagina do Double no navegador, aba Rede, filtro WS,');
    console.log('     e copiar o endereco real do socket para BLITZ_WS_URL;');
    console.log('  3. se houver Cloudflare no caminho, coletar via navegador headless.');
    process.exit(2);
  }

  console.log('\nColoque no .env:\n');
  console.log('SOURCE=blitz');
  if (bestWs) {
    console.log(`BLITZ_WS_URL=${bestWs.url}`);
    console.log('BLITZ_WS_PROTOCOL=socketio');
    console.log('BLITZ_WS_ROOMS=double_room_1');
  }
  if (bestRest) console.log(`BLITZ_REST_RECENT_URL=${bestRest.url}`);
  console.log(`BLITZ_ORIGIN=${origin}`);
  console.log(`BLITZ_REFERER=${target}`);

  const sample = bestWs?.sample ?? bestRest?.sample;
  if (sample) {
    console.log('\nExemplo de rodada reconhecida:');
    console.log(JSON.stringify(sample, null, 2));
    console.log('\nConfira se a cor esta certa. Se o mapa numerico for diferente,');
    console.log('ajuste BLITZ_COLOR_MAP (ex.: BLITZ_COLOR_MAP=0=B,1=A,2=P).');
  }
}

main().catch((err) => {
  console.error('erro no reconhecimento:', err instanceof Error ? err.message : err);
  process.exit(1);
});

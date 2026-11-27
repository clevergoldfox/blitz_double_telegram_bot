import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractRounds, inflateSocketPayload, unwrapSocketFrame, DEFAULT_COLOR_MAP } from '../src/sources/parsing';

/**
 * As amostras abaixo foram capturadas do feed real da Blitz em 2026-10-31.
 * Elas existem para travar o formato: se a plataforma mudar o payload, estes
 * testes quebram antes de o robo passar a emitir sinal errado em producao.
 */

// GET /api/singleplayer-originals/originals/roulette_games/recent/1
const RECENT_REAL = [
  { id: 'o5rVRbDJrK', created_at: '2026-10-31T12:09:40.339Z', color: 1, roll: 7, server_seed: '728575b8' },
  { id: 'Jw1Dv4jYlE', created_at: '2026-10-31T12:09:10.242Z', color: 1, roll: 2, server_seed: '1243b58b' },
  { id: '4J1m5b7D1j', created_at: '2026-10-31T12:08:40.150Z', color: 1, roll: 7, server_seed: '3b41a075' },
  { id: 'zokgRWLp1y', created_at: '2026-10-31T12:08:10.055Z', color: 2, roll: 14, server_seed: 'efe4d575' },
];

// evento double.tick do WebSocket, nas tres fases de um round
const TICK_WAITING = {
  id: 'double.tick',
  payload: {
    id: '9YrJvXRdrK', color: null, roll: null,
    created_at: '2026-10-31T12:13:41.088Z', updated_at: '2026-10-31T12:13:41.088Z',
    status: 'waiting', room_id: 4, total_white_bet: 20.46, bets: [],
  },
};
const TICK_ROLLING = {
  id: 'double.tick',
  payload: {
    id: 'WplzQx7Ykn', color: 1, roll: 7,
    created_at: '2026-10-31T12:15:11.000Z', updated_at: '2026-10-31T12:15:26.000Z',
    status: 'rolling', room_id: 4, bets: [],
  },
};
const TICK_COMPLETE = {
  id: 'double.tick',
  payload: {
    id: 'WplzQx7Ykn', color: 1, roll: 7,
    created_at: '2026-10-31T12:15:11.000Z', updated_at: '2026-10-31T12:15:36.000Z',
    status: 'complete', room_id: 4, bets: [],
  },
};

test('le a lista real de resultados recentes', () => {
  const rounds = extractRounds(RECENT_REAL);
  assert.equal(rounds.length, 4);
  // ordem cronologica crescente, independente da ordem que veio
  assert.deepEqual(rounds.map((r) => r.roundId), ['zokgRWLp1y', '4J1m5b7D1j', 'Jw1Dv4jYlE', 'o5rVRbDJrK']);
  assert.deepEqual(rounds.map((r) => r.color), ['P', 'A', 'A', 'A']);
});

test('mapa de cor confirmado ao vivo: 0=branco, 1-7=amarelo, 8-14=preto', () => {
  const amostra = [
    { id: 'a', color: 0, roll: 0, created_at: '2026-10-31T12:00:00.000Z' },
    { id: 'b', color: 1, roll: 1, created_at: '2026-10-31T12:00:30.000Z' },
    { id: 'c', color: 1, roll: 7, created_at: '2026-10-31T12:01:00.000Z' },
    { id: 'd', color: 2, roll: 8, created_at: '2026-10-31T12:01:30.000Z' },
    { id: 'e', color: 2, roll: 14, created_at: '2026-10-31T12:02:00.000Z' },
  ];
  assert.deepEqual(extractRounds(amostra).map((r) => r.color), ['B', 'A', 'A', 'P', 'P']);
  assert.equal(DEFAULT_COLOR_MAP['0'], 'B');
  assert.equal(DEFAULT_COLOR_MAP['1'], 'A');
  assert.equal(DEFAULT_COLOR_MAP['2'], 'P');
});

test('ignora round em aposta aberta (status waiting, cor nula)', () => {
  assert.deepEqual(extractRounds(TICK_WAITING), []);
});

test('aceita status rolling: a cor ja esta definida e chega ~10s antes', () => {
  const rounds = extractRounds(TICK_ROLLING);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].color, 'A');
  assert.equal(rounds[0].roll, 7);
  assert.equal(rounds[0].roundId, 'WplzQx7Ykn');
  // revealedAt vem de updated_at: e a referencia honesta para medir atraso
  assert.equal(rounds[0].revealedAt, '2026-10-31T12:15:26.000Z');
});

test('rolling e complete descrevem o mesmo round, com a mesma cor', () => {
  const r1 = extractRounds(TICK_ROLLING)[0];
  const r2 = extractRounds(TICK_COMPLETE)[0];
  assert.equal(r1.roundId, r2.roundId, 'mesmo round_id permite deduplicar');
  assert.equal(r1.color, r2.color, 'a cor nao muda de rolling para complete');
  assert.ok(
    new Date(r1.revealedAt!).getTime() < new Date(r2.revealedAt!).getTime(),
    'rolling chega antes de complete',
  );
});

test('decodifica o anexo binario do socket.io (deflate cru com 2 bytes de controle)', () => {
  const corpo = Buffer.from(JSON.stringify(TICK_ROLLING), 'utf8');
  const frame = Buffer.concat([Buffer.from([0x04, 0x02]), deflateRawSync(corpo)]);
  const msg = inflateSocketPayload(frame) as typeof TICK_ROLLING;
  assert.equal(msg.id, 'double.tick');
  assert.equal(msg.payload.roll, 7);
  // e o resultado precisa atravessar o extrator
  assert.equal(extractRounds(msg)[0].roundId, 'WplzQx7Ykn');
});

test('anexo binario invalido devolve null em vez de estourar', () => {
  assert.equal(inflateSocketPayload(Buffer.from([0x04, 0x02, 0x00, 0x01, 0x02])), null);
  assert.equal(inflateSocketPayload(Buffer.alloc(0)), null);
});

test('desembrulha frame de texto do socket.io', () => {
  assert.deepEqual(unwrapSocketFrame('42["double.tick",{"a":1}]'), ['double.tick', { a: 1 }]);
  assert.deepEqual(unwrapSocketFrame('0{"sid":"abc"}'), { sid: 'abc' });
  assert.equal(unwrapSocketFrame('40'), null);
  assert.equal(unwrapSocketFrame(''), null);
});

test('mapa de cor por texto tambem funciona (black/yellow/white)', () => {
  const amostra = [
    { id: 'x', color: 'black', created_at: '2026-10-31T12:00:00.000Z' },
    { id: 'y', color: 'yellow', created_at: '2026-10-31T12:00:30.000Z' },
    { id: 'z', color: 'white', created_at: '2026-10-31T12:01:00.000Z' },
  ];
  assert.deepEqual(extractRounds(amostra).map((r) => r.color), ['P', 'A', 'B']);
});

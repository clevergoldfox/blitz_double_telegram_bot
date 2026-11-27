import { parentPort, workerData } from 'node:worker_threads';
import { PedidoSimulacao, rodarSimulacao } from './simrun';

/**
 * Casca de worker thread em volta de `rodarSimulacao`.
 *
 * Existe so para tirar a simulacao da thread que atende o websocket da
 * plataforma e manda os alertas: mil dias levam mais de dez segundos de CPU
 * cheia, e um alerta do Double atrasado em dez segundos chega depois da rodada
 * que ele anunciava. Toda a logica esta em simrun.ts, para ser testavel sem
 * subir worker nenhum.
 */

if (!parentPort) throw new Error('simworker precisa ser carregado como worker thread');

try {
  parentPort.postMessage({ ok: true, dados: rodarSimulacao(workerData as PedidoSimulacao) });
} catch (err) {
  parentPort.postMessage({ ok: false, erro: err instanceof Error ? err.message : String(err) });
}

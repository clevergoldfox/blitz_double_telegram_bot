import { Config } from '../config';
import { Logger } from '../logger';
import { BlitzSource } from './blitz';
import { SimulatorSource } from './simulator';
import { ResultSource } from './types';

export { ResultSource } from './types';
export type { SourceStatus, SourceMode } from './types';

export function createSource(cfg: Config, log: Logger): ResultSource {
  if (cfg.source.kind === 'simulator') {
    log.warn(
      { intervalMs: cfg.source.simIntervalMs },
      'usando o SIMULADOR local: nenhum dado real da Blitz',
    );
    return new SimulatorSource(cfg.source.simIntervalMs, cfg.source.simScripted);
  }

  if (!cfg.source.wsUrl && !cfg.source.restRecentUrl) {
    throw new Error(
      'SOURCE=blitz exige BLITZ_WS_URL e/ou BLITZ_REST_RECENT_URL no .env.\n' +
        'Rode "npm run probe -- <url do Double>" para descobrir os enderecos.',
    );
  }

  return new BlitzSource(
    {
      wsUrl: cfg.source.wsUrl,
      wsSubscribe: cfg.source.wsSubscribe,
      restRecentUrl: cfg.source.restRecentUrl,
      pollMs: cfg.source.pollMs,
      origin: cfg.source.origin,
      referer: cfg.source.referer,
      userAgent: cfg.source.userAgent,
      colorMap: cfg.source.colorMap,
      fields: cfg.source.fields,
      requireComplete: cfg.source.requireComplete,
      staleAfterMs: cfg.source.staleAfterMs,
      backfillLimit: cfg.source.backfillLimit,
    },
    log.child({ mod: 'coletor' }),
  );
}

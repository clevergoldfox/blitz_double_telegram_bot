// tsc nao copia arquivos que nao sao .ts; o schema e o painel precisam ir junto para dist/.
const { copyFileSync, cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const raiz = join(__dirname, '..');

const saidaDb = join(raiz, 'dist', 'src', 'db');
mkdirSync(saidaDb, { recursive: true });
copyFileSync(join(raiz, 'src', 'db', 'schema.sql'), join(saidaDb, 'schema.sql'));

const saidaWeb = join(raiz, 'dist', 'src', 'web', 'public');
cpSync(join(raiz, 'src', 'web', 'public'), saidaWeb, { recursive: true });

console.log('assets copiados para dist/src/db e dist/src/web/public');

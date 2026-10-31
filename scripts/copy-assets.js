// tsc nao copia arquivos que nao sao .ts; o schema precisa ir junto para dist/.
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const out = join(__dirname, '..', 'dist', 'src', 'db');
mkdirSync(out, { recursive: true });
copyFileSync(join(__dirname, '..', 'src', 'db', 'schema.sql'), join(out, 'schema.sql'));
console.log('assets copiados para dist/src/db');

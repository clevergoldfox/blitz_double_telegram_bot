# Subir no servidor (passo a passo)

Roteiro completo para tirar o robô da máquina local e deixá-lo 24h no ar, com o
painel acessível pela internet via HTTPS.

Leva cerca de **40 minutos** na primeira vez.

---

## Antes de começar: duas coisas que quebram tudo

**1. Dois robôs no mesmo token brigam.** O Telegram só entrega atualizações para
um processo por token. Se o robô local continuar rodando quando o do servidor
subir, os dois vão revezar mensagens e o cliente vai ver comandos sumindo. **Pare
o local antes de ligar o remoto** — está no passo 6, mas é o erro mais fácil de
cometer.

**2. O histórico é o produto.** As rodadas guardadas são o que dá valor ao botão
"testar". Começar do zero no servidor joga meses de backtest fora. O passo 5
copia o banco.

---

## 1. Contratar o servidor

O feed da Blitz responde de qualquer lugar (confirmado de um IP fora do Brasil),
então **o servidor não precisa estar no Brasil**. Qualquer VPS básico serve: o
robô consome pouco mais de 100 MB de RAM.

| Provedor | Plano | Preço aproximado |
|---|---|---|
| Hetzner | CX22 — 2 vCPU, 4 GB | ~€4/mês (melhor custo) |
| Contabo | VPS S | ~€6/mês |
| DigitalOcean / Vultr | 1 GB | ~US$5-6/mês |
| Hostinger | KVM 1 | ~R$30/mês (cobrança em real) |

Escolha **Ubuntu 24.04 LTS**. Guarde o IP.

> **Cuidado ao comprar pelo celular.** Na Hostinger, a tela estreita pula a
> escolha do sistema e entrega AlmaLinux com CyberPanel. Isso nao serve: e outra
> familia de Linux (sem `apt`) e o CyberPanel ja ocupa as portas 80/443. Conserto
> pelo computador, em **Gerenciar -> Sistema operacional**, na aba de sistema
> *puro* (nao a de sistema *com painel*). Reinstalar apaga o servidor inteiro, o
> que num servidor recem-comprado nao custa nada.

Um detalhe sobre latência: um servidor na Europa fica a uns 200 ms do Brasil. Como
o alerta já chega 15 segundos antes de a próxima rodada abrir para aposta, isso não
muda nada na prática. Se preferir folga, São Paulo existe em quase todos eles.

## 2. Apontar um nome para o IP

O certificado HTTPS precisa de um nome, não de um IP.

- **Se você já tem domínio:** crie um registro `A` de `painel.seudominio.com`
  apontando para o IP.
- **Se não tem:** use o [DuckDNS](https://www.duckdns.org) — grátis, dá um nome
  tipo `robo-double.duckdns.org` e funciona com o certbot.
- **Na Hostinger, já vem um pronto:** cada VPS nasce com um nome do tipo
  `srv2135450.hstgr.cloud` que já aponta para o próprio IP (A e AAAA). Confira
  com `nslookup`; se bater com o IP, use esse e pule este passo inteiro.

## 3. Preparar o servidor

```bash
ssh root@SEU-IP

apt update && apt upgrade -y
apt install -y git nginx certbot python3-certbot-nginx ufw

# Só SSH e web. A porta 8080 do painel NUNCA é aberta:
# quem fala com a internet é o nginx, com certificado.
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 4. Enviar o projeto

Do seu computador, **sem o `node_modules`, sem o `dist` e sem o `.env`**:

```bash
cd /c/Users/Administrator/Documents/02_work/2026_11/04_telebot

tar --exclude=node_modules --exclude=dist --exclude=data --exclude=.env \
    -czf robo.tgz .

scp robo.tgz root@SEU-IP:/tmp/
ssh root@SEU-IP "mkdir -p /opt/blitz-double-bot && tar -xzf /tmp/robo.tgz -C /opt/blitz-double-bot && rm /tmp/robo.tgz"
```

Depois mande o `.env` separado (ele tem o token e a senha do painel):

```bash
scp .env root@SEU-IP:/opt/blitz-double-bot/.env
ssh root@SEU-IP "chmod 600 /opt/blitz-double-bot/.env"
```

**Tire o `\r` do Windows.** Os arquivos saem daqui com quebra de linha CRLF,
e o Linux engasga: o `instalar.sh` morre com `/usr/bin/env: 'bash\r': No such
file or directory`, e um `\r` preso no fim do token do Telegram derruba a
autenticação sem dizer por quê.

```bash
ssh root@SEU-IP "cd /opt/blitz-double-bot && sed -i 's/\r$//' .env deploy/*.sh deploy/*.service deploy/*.conf"
```

## 5. Levar o histórico junto

**Adiante o trabalho pesado antes de desligar nada.** O Node, o `npm ci` e o
`build` levam vários minutos e não dependem do banco. Rode-os primeiro e o
cliente fica fora do ar por um minuto, não por quinze:

```bash
ssh root@SEU-IP "cd /opt/blitz-double-bot && npm ci --omit=dev &&   npm install --no-save typescript@5.7.2 @types/node@22.10.2 @types/ws@8.5.13 &&   npm run build"
```

(O `instalar.sh` vai repetir esses passos no passo 6, mas aí já estarão prontos e
ele passa reto.)

**Agora pare o robô local** — copiar um SQLite em uso traz um banco pela
metade.

```powershell
# no Windows, pare o processo do robô
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dist/src/index.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Com o robô parado, junte o WAL ao arquivo principal — assim você copia um
arquivo só, sem risco de deixar escrita para trás:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/bot.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
```

```bash
ssh root@SEU-IP "mkdir -p /opt/blitz-double-bot/data"
scp data/bot.db root@SEU-IP:/opt/blitz-double-bot/data/bot.db
```

A partir daqui o cliente fica sem alertas até o passo 6 terminar — uns 15
minutos. Se ele estiver operando, avise antes.

O robô religa o histórico sozinho ao subir: ele busca as rodadas recentes e
costura o intervalo em que ficou fora. Se o buraco for grande demais para ele
provar que não perdeu nada, ele **pausa os alertas** e avisa no Telegram até
recompor a janela — é o comportamento certo, não um defeito.

## 6. Instalar e ligar

```bash
ssh root@SEU-IP
cd /opt/blitz-double-bot
./deploy/instalar.sh
```

O script instala o Node, cria o usuário de serviço, compila, registra no systemd
com `Restart=always` e já diz o endereço do painel.

```bash
systemctl status blitz-double-bot
journalctl -u blitz-double-bot -f        # acompanhe a primeira conexão
```

Você deve ver, em sequência: `bot do Telegram autenticado` → `coletor: WebSocket
conectado` → `coletor: sala assinada` → `painel no ar`.

## 7. Publicar o painel com HTTPS

```bash
# o limite de tentativas de login precisa estar declarado no bloco http{}
sed -i '/^http {/a \    limit_req_zone $binary_remote_addr zone=painel_login:10m rate=1r/s;' /etc/nginx/nginx.conf

cp /opt/blitz-double-bot/deploy/nginx-painel.conf /etc/nginx/sites-available/painel
sed -i 's/painel.SEU-DOMINIO.com/painel.seudominio.com/' /etc/nginx/sites-available/painel
ln -sf /etc/nginx/sites-available/painel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
certbot --nginx -d painel.seudominio.com
```

Com o certificado no ar, ligue o cookie seguro:

```bash
sed -i 's/^WEB_SECURE_COOKIE=.*/WEB_SECURE_COOKIE=true/' /opt/blitz-double-bot/.env
systemctl restart blitz-double-bot
```

Abra `https://painel.seudominio.com` e entre com a senha do `.env`.

## 8. Backup automático

O banco é um arquivo só. Uma linha no cron resolve:

```bash
mkdir -p /opt/backups
crontab -e
```

```cron
0 4 * * * sqlite3 /opt/blitz-double-bot/data/bot.db ".backup '/opt/backups/bot-$(date +\%F).db'" && find /opt/backups -name 'bot-*.db' -mtime +14 -delete
```

Guarda 14 dias. Use `.backup` do sqlite3, e não `cp`: ele copia um banco em uso
sem risco de pegar a escrita pela metade.

---

## Conferência final

- [ ] `systemctl status blitz-double-bot` → `active (running)`
- [ ] O robô mandou "🤖 Robô online" no Telegram
- [ ] `/status` no Telegram responde com atraso abaixo de 1s
- [ ] O painel abre em **https** (cadeado fechado) e aceita a senha
- [ ] `/padroes` mostra os padrões do cliente, com o placar antigo preservado
- [ ] O robô **local** está parado
- [ ] `curl http://SEU-IP:8080` não responde de fora (o firewall barra)

## Manutenção no dia a dia

```bash
journalctl -u blitz-double-bot -f          # acompanhar
systemctl restart blitz-double-bot         # reiniciar
```

Para subir uma correção:

```bash
cd /opt/blitz-double-bot
git pull            # ou reenvie o tar do passo 4
npm run build
systemctl restart blitz-double-bot
```

O painel e os padrões não se perdem: tudo mora no banco, que o `build` não toca.

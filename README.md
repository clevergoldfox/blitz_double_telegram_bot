# Robô de Padrões — Double da Blitz

Robô de **alertas** para o jogo Double, integrado ao Telegram. Você cadastra seus
padrões pelo próprio Telegram, sem mexer em código, e o robô avisa na hora em que
cada padrão se confirma, acompanha os gales e registra GREEN/RED com placar de
assertividade por padrão.

O robô **não aposta**. Ele apenas monitora e avisa.

---

## O que ele faz

- **Captura os resultados do Double em tempo real** (WebSocket, com polling REST como reserva)
- **Cadastro ilimitado de padrões** pelo Telegram, cada um com:
  - sequência de gatilho (com curingas e repetições)
  - cor de entrada
  - número de gales (0, 1 ou 2)
  - tratamento do branco
- Monitora **todos os padrões ativos ao mesmo tempo**
- Fluxo de alerta: **entrada → G1 → G2 → GREEN/RED**
- **Placar de assertividade por padrão**, por dia, semana ou total
- **Teste no histórico** (`/testar`): roda o padrão sobre tudo que já foi guardado e
  mostra a frequência real dele, sem você precisar esperar semanas
- Roda 24h em servidor Linux, com log, reconexão automática e proteção contra
  histórico furado

---

## Instalação rápida

Requer **Node.js 22.5 ou superior** (usa o SQLite nativo do Node, então não há
compilação de módulo nativo).

```bash
npm install
cp .env.example .env    # preencha o .env
npm run build
npm start
```

### Preenchendo o `.env`

1. Crie o bot no **@BotFather** e copie o token para `TELEGRAM_BOT_TOKEN`.
2. Rode o robô, mande `/id` para o bot e copie:
   - seu id de usuário → `TELEGRAM_OWNER_IDS`
   - o id do chat/grupo/canal → `TELEGRAM_CHAT_ID`
3. Reinicie.

> Se o destino for um **grupo ou canal**, adicione o bot como administrador.
> O id desses chats normalmente começa com `-100`.

---

## Conectando no feed da Blitz

A Blitz não publica API documentada, e o endereço real só se confirma de dentro do
servidor. Existe uma ferramenta para descobrir isso sozinha:

```bash
npm run build
node dist/src/probe.js https://<site>/games/double
```

Ela busca a página, varre o HTML e os bundles de JavaScript procurando endereços de
API e WebSocket, testa cada candidato e imprime as linhas de `.env` que funcionam.

**Rode sempre no servidor onde o robô vai ficar.** Casas brasileiras costumam
bloquear IP de fora do Brasil, e o resultado depende do IP de saída.

A ferramenta também distingue dois casos que parecem iguais e não são:

- resposta **404** → aquele caminho não existe;
- resposta **401 / 403 / 503** → o caminho existe, mas está **barrado para este IP**.

No segundo caso, o problema é a localização do servidor, não o endereço.

Se o `probe` não achar nada, o caminho manual é: abrir a página do Double no
navegador, aba **Rede**, filtro **WS**, e copiar o endereço do socket para
`BLITZ_WS_URL` e a primeira mensagem enviada para `BLITZ_WS_SUBSCRIBE`.

### Enquanto o feed não está ligado

```bash
SOURCE=simulator
```

O simulador é uma roleta local com a composição real do Double (15 casas: 7 pretas,
7 amarelas, 1 branca). Serve para testar o robô inteiro de ponta a ponta e para
gerar histórico. Para ver funcionando no terminal, sem Telegram:

```bash
npm run demo                              # padrão P P A P A, entrada no preto, até G1
node dist/src/demo.js "P{3}" A 2 protege  # outro padrão
```

---

## Comandos do Telegram

### Cadastrar

```
/novo <sequência> = <entrada> [G0|G1|G2] [branco:gale|red|protege] [nome]
```

```
/novo P P A P A = P G1 sem branco
/novo ⚫⚫🟡⚫🟡 = ⚫ G1
/novo P{3} = A G2 branco:protege Três pretos
/novo !B{10} = B G0 Dez sem branco
/novo Preto+Preto+amarelo+preto+amarelo = preto até g1 sem proteção no branco
```

### Gerenciar

| Comando | O que faz |
|---|---|
| `/padroes` | lista tudo, com placar de cada um |
| `/editar <id> <campo> <valor>` | campos: `nome`, `seq`, `entrada`, `gales`, `branco` |
| `/ativar <id>` · `/desativar <id>` | liga e desliga sem perder o histórico |
| `/excluir <id>` | remove de vez |

### Consultar

| Comando | O que faz |
|---|---|
| `/placar [id] [hoje\|semana\|total]` | assertividade, geral ou de um padrão |
| `/testar <id>` | roda o padrão no histórico guardado |
| `/ultimos [n]` | últimas rodadas capturadas |
| `/status` | conexão, atraso do último round, saúde do robô |
| `/id` | seu id e o id do chat |
| `/ajuda` | resumo de tudo |

---

## Como escrever um padrão

Cores: **P** = preto, **A** = amarelo, **B** = branco.

Aceita também emoji (⚫ 🟡 ⚪) e o nome da cor escrito ("preto", "amarelo"). Os
separadores são livres: `P P A`, `PPA`, `P+P+A` e `P,P,A` são a mesma coisa.

| Escrita | Significado |
|---|---|
| `P P A P A` | preto, preto, amarelo, preto, amarelo |
| `P{3}` | três pretos seguidos |
| `P{2,4}` | de dois a quatro pretos |
| `*` | qualquer cor, inclusive branco |
| `!B` | qualquer cor que não seja branco |
| `!B{10}` | dez rodadas sem branco |
| `P A P A P` | alternância preto/amarelo |
| `P * P` | preto, qualquer cor, preto |

O padrão é conferido sempre **no fim do histórico**: ele dispara no momento em que a
última rodada completa a sequência.

### O branco

Esta é a parte que muda o resultado e que vale conferir. "Sem proteção no branco"
pode significar duas coisas diferentes, então as duas estão disponíveis:

| Configuração | O que acontece quando sai branco |
|---|---|
| `branco:gale` *(padrão)* | o branco **perde a tentativa e vai para o gale** — leitura usual do mercado |
| `branco:red` | o branco **encerra o sinal como RED na hora**, mesmo com gale sobrando |
| `branco:protege` | o branco **conta como GREEN** (aposta protegida no branco) |

Quando a entrada é no próprio branco, acertar o branco é GREEN normalmente.

---

## Servidor (24h)

```bash
sudo cp -r . /opt/blitz-double-bot
cd /opt/blitz-double-bot
sudo ./deploy/instalar.sh
```

O script instala o Node, cria o usuário de serviço, compila e registra o serviço no
systemd com `Restart=always`.

```bash
systemctl status blitz-double-bot
journalctl -u blitz-double-bot -f      # acompanhar ao vivo
systemctl restart blitz-double-bot
```

Backup é só copiar o arquivo do banco:

```bash
cp /opt/blitz-double-bot/data/bot.db  /onde/quiser/bot-$(date +%F).db
```

---

## Cuidados que estão no código

**Histórico furado.** Se o robô perder rodadas numa queda de conexão, ele passaria a
comparar padrões contra um histórico incompleto e emitiria sinais errados **sem
nenhum aviso**. Para evitar isso, ao reconectar ele busca o histórico recente e
confere a continuidade. Se não conseguir provar que nada foi perdido, ele **pausa os
alertas** e avisa no Telegram até reconstruir a janela necessária. `/status` mostra
se os alertas estão armados.

**Alerta duplicado.** Um padrão com sinal em aberto não dispara de novo — inclusive
no caso de sequências que se sobrepõem a si mesmas, como `P P A P A`. A trava está
no próprio banco, não só no código.

**Atraso.** O round do Double deixa poucos segundos de aposta aberta, então um alerta
atrasado não serve. O caminho principal é o WebSocket, e `/status` mostra o atraso do
último round em milissegundos, para você conferir se está dentro do útil.

**Placar confiável.** O `/testar` e o placar ao vivo usam exatamente a mesma função de
resolução de gale e branco, e existe teste automatizado comparando os dois sobre o
mesmo histórico. Isso impede que um mostre um número e o outro mostre outro.

---

## Testes

```bash
npm test
```

40 testes cobrindo a gramática de padrões, o casamento de sequências, a máquina de
gales, as três regras de branco, a trava de alerta duplicado, a proteção de histórico
e a concordância entre o placar ao vivo e o teste histórico.

---

## Estrutura

```
src/
  index.ts          inicialização e ligação das partes
  config.ts         leitura e validação do .env
  types.ts          cores, padrão, sinal, placar
  db/               SQLite (schema + repositórios)
  engine/
    grammar.ts      leitura da sintaxe de padrão
    matcher.ts      casamento da sequência no fim do histórico
    rules.ts        regra única de gale e branco
    engine.ts       ordem de processamento e estado dos sinais
    backtest.ts     reexecução sobre o histórico
  sources/
    blitz.ts        feed real (WebSocket + REST, reconexão, backfill)
    simulator.ts    roleta local
    parsing.ts      leitura tolerante do JSON da plataforma
  bot/              comandos e textos do Telegram
  notifier/         fila de envio com controle de limite
  probe.ts          descoberta do endereço do feed
```

---

## Observação importante

O robô mostra **frequência histórica** dos padrões que você cadastrar. Ele não prevê o
próximo giro.

Vale saber o número de base: o Double tem 15 casas, sendo 7 pretas, 7 amarelas e 1
branca. Como cada giro é independente, uma entrada em cor com 1 gale tende a cerca de
**71,6%** de acerto no longo prazo — `7/15 + (8/15 × 7/15)` — **qualquer que seja a
sequência que veio antes**. O placar por padrão existe justamente para você comparar
os seus padrões contra essa base, com dado real em vez de impressão.

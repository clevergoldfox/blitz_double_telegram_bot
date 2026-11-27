# Robô de Padrões — Double da Blitz

Robô de **alertas** para o jogo Double, integrado ao Telegram. Você cadastra seus
padrões pelo próprio Telegram, sem mexer em código, e o robô avisa na hora em que
cada padrão se confirma, acompanha os gales e registra GREEN/RED com placar de
assertividade por padrão.

O robô **não aposta**. Ele apenas monitora e avisa.

---

## O que ele faz

- **Captura os resultados do Double em tempo real** (WebSocket, com polling REST como reserva)
- **Painel web** para cadastrar, editar e testar padrões com o mouse
- **Cadastro ilimitado de padrões** pelo Telegram ou pelo painel, cada um com:
  - sequência de gatilho — por **cor**, por **número da pedra**, com curingas e repetições
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

## O feed da Blitz (já confirmado e funcionando)

O feed de `blitz4.casino` foi identificado, testado ao vivo e já está configurado no
`.env.example`. Não há nada a descobrir: é só preencher o Telegram e subir.

| | |
|---|---|
| WebSocket | `wss://api-gaming.blitz4.casino/replication/?EIO=4&transport=websocket&binary=1` |
| Sala | `double_room_1` |
| REST (reserva/backfill) | `.../originals/roulette_games/recent/1` |
| Atraso medido | **0,3s** em média, 0,4s no pior caso |

### Como a rodada funciona

Medido ao vivo, cada rodada dura **30 segundos** e passa por três fases:

| Momento | Fase | Cor |
|---|---|---|
| 0s | `waiting` — apostas abertas | ainda não definida |
| 15s | `rolling` — girando | **já revelada** |
| 25s | `complete` | a mesma |
| 30s | próxima rodada abre | |

Isso é melhor do que parece: a cor sai em `rolling`, **10 segundos antes** de
`complete` e cerca de **15 segundos antes** de a próxima rodada abrir para aposta. O
robô usa o `rolling` justamente por isso, e descarta o `complete` repetido pelo
`round_id`. Na prática o alerta chega com folga confortável para você apostar.

A cor vem como número e foi conferida contra os sorteios reais: `0` = branco (roll 0),
`1` = amarelo (rolls 1 a 7), `2` = preto (rolls 8 a 14).

### Conferir o feed sem Telegram

```bash
npm run ao-vivo            # 3 minutos
npm run ao-vivo -- 600     # 10 minutos
```

Liga o coletor real no motor de padrões e imprime no terminal os mesmos alertas que
sairiam no Telegram, com o atraso de cada rodada. É a forma de confirmar que o feed
está de pé antes de apontar o robô para o seu chat.

### Outra plataforma

Se um dia o endereço mudar, ou você quiser usar outra casa:

```bash
node dist/src/probe.js https://<site>/games/double
```

A ferramenta busca a página, varre o HTML e os bundles de JavaScript procurando
endereços de API e WebSocket, testa cada candidato e imprime as linhas de `.env` que
funcionam. Ela também separa dois casos que parecem iguais: resposta **404** significa
que o caminho não existe, e **401/403/503** significa que existe mas está barrado para
aquele IP — aí o problema é a localização do servidor, não o endereço.

### Modo simulador

```bash
SOURCE=simulator
```

Roleta local com a composição real do Double (15 casas: 7 pretas, 7 amarelas, 1
branca). Serve para testar o robô sem depender da plataforma e para gerar histórico.
Para ver no terminal:

```bash
npm run demo                              # padrão P P A P A, entrada no preto, até G1
node dist/src/demo.js "P{3}" A 2 protege  # outro padrão
```

## O painel

Tela web para fazer com o mouse tudo que os comandos fazem — e o lugar certo para
**testar ideias de padrão em série** antes de deixar qualquer uma ativa.

```
WEB_PASSWORD=escolha-uma-senha-forte
WEB_PORT=8080
```

Sem `WEB_PASSWORD` o painel nem sobe. Com ela, o robô passa a servir o painel em
`http://127.0.0.1:8080` junto com o Telegram, no mesmo processo e no mesmo banco —
o que você muda num lado aparece no outro na hora.

O que tem nele:

- **Últimas rodadas** com o número de cada pedra, atualizando sozinho
- **Lista de padrões** com placar de cada um e a linha de base ao lado
- **Editor** com botões de cor, teclado de pedras (0 a 14) e o campo *esperar N casas*
- **Testar no histórico** sem salvar nada: escreve, clica e vê o resultado sobre tudo
  que já foi coletado
- **Trava de estratégia** (o mesmo `/modo`) num botão
- **Simulador de banca**: a sua tabela de apostas rodada no histórico real e em
  até 1.000 dias de roleta honesta, com gráfico de saldo e extrato

### A linha de base

Todo teste mostra dois números: o acerto do seu padrão e a **linha de base** — o que
uma entrada na mesma cor, com os mesmos gales e a mesma regra de branco, daria
**sem padrão nenhum na frente**.

Essa comparação é o ponto do painel. Um padrão que acerta 78% parece ótimo até você
ver que a entrada sozinha já daria 78%. O painel diz isso na cara, inclusive quando
a amostra ainda é pequena demais para concluir qualquer coisa.

Na lista de padrões, cada taxa vem com o **intervalo de confiança** e um rótulo:
*acima da base*, *empata com a base*, *abaixo da base* ou *poucos sinais ainda*. O
rótulo leva o tamanho da amostra em conta, e é por isso que ele existe: um padrão
com 12 acertos em 13 sinais mostra 92,3%, mas o intervalo dele vai de 66,7% a
98,6% — ele não sustenta conclusão nenhuma, e destacá-lo como o melhor da lista
levaria você a apostar mais justamente no padrão que você menos conhece.

### Simulador de banca

A aba **Simulador de banca** responde a pergunta que o placar de acerto não responde:
*com essa tabela de apostas e essa meta, quanto sobra no fim do mês?*

Você monta a **tabela de degraus** — quanto vai na cor e quanto vai na proteção do
branco em cada nível, de 1 a 12 degraus. O robô entra no degrau 1 quando o padrão
dispara e, se perder, sobe para o seguinte. Não é martingale fixo: cada degrau tem o
valor que você digitar, porque tabela de recuperação real não dobra bonitinho.

Dá para mexer em tudo sem pedir nada a ninguém: banca inicial, meta do dia, horário
de operação, quais padrões operam, se o dia encerra ao perder a escada, se o branco
reinicia a contagem.

O resultado vem em três colunas que se conferem entre si:

- **A tabela no papel** — a conta fechada, sem simular nada: quanto cada escada rende
  ganhando, quanto custa perdendo, de quantas em quantas escadas uma se perde, quantas
  escadas ganhas **seguidas** a meta exige e que chance isso tem de acontecer.
- **Histórico real** — a mesma tabela rodada em tudo que o robô já gravou.
- **Roleta honesta** — a mesma tabela rodada em até 1.000 dias de uma roda
  comprovadamente justa, com semente fixa (mesma semente, mesmo sorteio).

A terceira coluna é a que mais importa, e é por isso que ela existe. Histórico curto
engana: os primeiros 27 dias gravados correram a −1,8% quando a margem da casa é
−6,7%, e qualquer tabela medida só ali pareceria boa. A coluna de controle separa o
que a estratégia faz do que o período fez por ela.

Abaixo vêm o **gráfico de saldo**, uma barra por dia (verde para cima, vermelha para
baixo), a tabela **dia por dia** com o motivo de cada fim e o **extrato** aposta por
aposta, com o degrau em que cada ciclo fechou.

Duas linhas do placar merecem atenção:

- **Metas por dia perdido** — quantas metas batidas cobrem um dia perdido, e quantas
  a tabela de fato entrega. Enquanto a primeira for maior que a segunda, operar mais
  dias é perder mais dinheiro, não menos.
- **Margem sobre o girado** — tende a −6,67% em qualquer tabela, porque a casa cobra
  por volume apostado e não por aposta. Nenhuma tabela de degraus muda esse número;
  o que ela muda é o tamanho dos sustos no caminho.

A simulação roda numa *worker thread*: mil dias levam uns doze segundos de CPU, e
rodar isso na thread principal atrasaria alertas de verdade no Telegram.

### Publicar com HTTPS

O painel escuta só em `127.0.0.1` de propósito: assim a senha nunca trafega sem
certificado. Para acessar de fora, use o nginx:

```bash
sudo cp deploy/nginx-painel.conf /etc/nginx/sites-available/painel
sudo ln -s /etc/nginx/sites-available/painel /etc/nginx/sites-enabled/
sudo certbot --nginx -d painel.SEU-DOMINIO.com
```

Depois do certificado, ligue `WEB_SECURE_COOKIE=true` no `.env` e reinicie.

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
| `/modo publico` · `/modo completo` | mostra ou oculta a estratégia nos alertas |
| `/id` | seu id e o id do chat |
| `/ajuda` | resumo de tudo |

### Revender os sinais

Se você repassa os alertas para outras pessoas, o `Gatilho:` e o nome do padrão
entregam a sua estratégia de graça — quem recebe consegue copiar e parar de pagar.

```
/modo publico
```

A partir daí o alerta sai assim:

```
🚨 ENTRADA CONFIRMADA

Sinal #12

➡️ Entrar no 🟡 AMARELO
ate G1 · com protecao no branco

Placar deste padrao: 11V / 3D (78,6%)
```

O assinante continua sabendo tudo que precisa para apostar — cor, gale, proteção no
branco e o placar do sinal — mas não o padrão que disparou. Esconder só o `Gatilho:`
não bastaria: quando você cadastra sem dar um nome, o robô usa a própria sequência
como nome, então ela vazaria pelo cabeçalho. Por isso o modo público troca o
cabeçalho inteiro por `Sinal #id`.

Para voltar a ver a estratégia:

```
/modo completo
```

A escolha fica guardada no banco, não no `.env`: reiniciar o robô ou reinstalar no
servidor não reabre a estratégia de um grupo que você fechou. O `/modo` sem
argumento mostra em qual você está, e ao trocar o robô imprime um exemplo do alerta
já no formato novo, para você conferir antes de o padrão disparar.

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

### Por número da pedra

Além da cor, o padrão pode olhar **o número sorteado** (0 a 14). O robô guarda esse
número desde sempre, então um padrão por número já nasce com todo o histórico
disponível para teste.

| Escrita | Significado |
|---|---|
| `5` | saiu a pedra 5 |
| `[1,5,9]` | saiu 1, 5 ou 9 |
| `8-14` | qualquer pedra da faixa do preto |
| `!0` | qualquer pedra menos o branco |
| `0 P P` | branco, depois dois pretos — número e cor no mesmo padrão |
| `8-14{3}` | três pretos seguidos, escrito por número |

### Esperar antes de entrar

Dá para separar o gatilho da entrada:

```
/novo pedra 5 apos 5 casas = A G1
```

**"após N casas" quer dizer: a entrada acontece na N-ésima rodada depois do
gatilho.** Com `apos 5 casas`, saiu o 5, passam quatro rodadas e a entrada é na
quinta. Internamente isso vira `5 *{4}` — o painel tem um campo para isso, para
você não precisar contar.

> ⚠️ No Double a aposta é sempre em **cor**: preto, amarelo ou branco. A casa não
> aceita aposta em número. Por isso o número serve de **gatilho**, e a entrada
> continua sendo uma cor.

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

**Atraso.** Um alerta que chega depois de fechar a aposta não serve. O caminho
principal é o WebSocket, com atraso medido de **0,3s**, e o robô usa a fase `rolling`
para ganhar mais 10 segundos. O `/status` mostra o atraso do último round contado a
partir do instante em que a cor foi revelada — e não da abertura da rodada, que daria
uns 15s e faria o robô parecer lento sem motivo.

**Conexão de pé.** O servidor da Blitz anuncia um ping de 25s mas nunca envia o dele:
quem só espera leva desconexão a cada 46 segundos. O robô manda o ping por conta
própria a cada 20s, e com isso a conexão fica estável.

**Placar confiável.** O `/testar` e o placar ao vivo usam exatamente a mesma função de
resolução de gale e branco, e existe teste automatizado comparando os dois sobre o
mesmo histórico. Isso impede que um mostre um número e o outro mostre outro.

---

## Testes

```bash
npm test
```

88 testes cobrindo a gramática de padrões (cor e número), o casamento de sequências,
a máquina de gales, as três regras de branco, a trava de alerta duplicado, a proteção
de histórico, o modo que oculta a estratégia, a API do painel (sessão, validação,
passeio de diretório) e a leitura do formato real da Blitz — as amostras usadas nos
testes foram capturadas do feed de verdade, então se a plataforma mudar o payload os
testes quebram antes de o robô errar em produção.

O teste mais importante compara **o placar ao vivo com o backtest** sobre o mesmo
histórico, em nove configurações diferentes. É o que garante que o número do painel
e o número do Telegram nunca discordem.

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
    rules.ts        regra única de gale e branco, linha de base e intervalos
    engine.ts       ordem de processamento e estado dos sinais
    backtest.ts     reexecução sobre o histórico
    banca.ts        a mesma reexecução contando dinheiro (tabela de degraus)
    roleta.ts       roda honesta de controle, com semente fixa
    simrun.ts       uma rodada de simulação, do pedido ao resultado da tela
    simworker.ts    casca de worker thread para não travar os alertas
  sources/
    blitz.ts        feed real (WebSocket + REST, reconexão, backfill)
    simulator.ts    roleta local
    parsing.ts      leitura tolerante do JSON da plataforma
  bot/              comandos e textos do Telegram
  web/
    server.ts       API e arquivos do painel
    auth.ts         senha, sessão assinada e freio de força bruta
    public/         a tela do painel (HTML, CSS e JS, sem framework)
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

'use strict';

/* Painel do robo. Sem framework: sao poucas telas e o que importa aqui e
   nao divergir do motor — todo numero mostrado vem do servidor. */

const $ = (sel) => document.querySelector(sel);
const EMOJI = { P: '⚫', A: '\u{1F7E1}', B: '⚪' };
const NOME_COR = { P: 'Preto', A: 'Amarelo', B: 'Branco' };
const NOME_BRANCO = {
  gale: 'branco vai pro gale',
  red: 'branco = RED na hora',
  protect: 'branco protegido',
};
/**
 * Veredito do padrao contra a propria linha de base. O texto e a cor vem do
 * veredito do servidor, nunca de comparar as duas taxas aqui: a comparacao
 * crua ignora o tamanho da amostra.
 */
const TEXTO_VEREDITO = {
  poucosDados: 'poucos sinais ainda',
  acima: 'acima da base',
  dentro: 'empata com a base',
  abaixo: 'abaixo da base',
};
const CLASSE_VEREDITO = {
  poucosDados: 'discreto',
  acima: 'verde',
  dentro: 'neutro',
  abaixo: 'vermelho',
};

let estado = null;
let editandoId = null;
let timer = null;

// ---------- utilidades ----------

async function api(caminho, opts = {}) {
  const r = await fetch('/api' + caminho, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let dados = {};
  try { dados = await r.json(); } catch { /* resposta sem corpo */ }
  if (r.status === 401 && caminho !== '/login') {
    mostrarLogin();
    throw new Error('Sessão expirada. Entre de novo.');
  }
  if (!r.ok) throw new Error(dados.erro || `Falha (${r.status})`);
  return dados;
}

function pct(n) {
  return (n * 100).toFixed(1).replace('.', ',') + '%';
}

function avisar(msg) {
  const el = $('#aviso');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function mostrarErro(seletor, msg) {
  const el = $(seletor);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

// ---------- login ----------

function mostrarLogin() {
  clearInterval(timer);
  timer = null;
  $('#tela-painel').hidden = true;
  $('#tela-login').hidden = false;
  $('#senha').value = '';
  $('#senha').focus();
}

function mostrarPainel() {
  $('#tela-login').hidden = true;
  $('#tela-painel').hidden = false;
  if (!timer) timer = setInterval(() => void carregar(true), 10000);
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  mostrarErro('#erro-login', '');
  try {
    await api('/login', { method: 'POST', body: { senha: $('#senha').value } });
    mostrarPainel();
    await carregar();
  } catch (err) {
    mostrarErro('#erro-login', err.message);
  }
});

$('#btn-sair').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  mostrarLogin();
});

// ---------- estado ----------

async function carregar(silencioso = false) {
  try {
    estado = await api('/estado');
    desenhar();
  } catch (err) {
    if (!silencioso) avisar(err.message);
  }
}

function desenhar() {
  const f = estado.fonte;

  const conexao = $('#selo-conexao');
  conexao.textContent = f.connected ? 'conectado' : 'desconectado';
  conexao.className = 'selo ' + (f.connected ? 'selo--ok' : 'selo--ruim');

  const armado = $('#selo-armado');
  armado.textContent = estado.armado ? 'alertas armados' : 'alertas pausados';
  armado.className = 'selo ' + (estado.armado ? 'selo--ok' : 'selo--ruim');

  const modo = $('#btn-modo');
  const publico = estado.modo === 'publico';
  modo.textContent = publico ? '🔒 estratégia oculta' : '🔓 estratégia visível';
  modo.className = 'selo selo--botao' + (publico ? ' selo--ok' : '');

  const atraso = f.lastLatencyMs === null ? '—' : (f.lastLatencyMs / 1000).toFixed(1) + 's';
  $('#fonte-detalhe').textContent = `${f.mode.toUpperCase()} · atraso ${atraso}`;

  $('#total-rodadas').textContent = `${estado.totalRodadas.toLocaleString('pt-BR')} rodadas guardadas`;

  const g = estado.placarGeral;
  $('#placar-geral').textContent = g.total
    ? `geral: ${g.greens}V / ${g.reds}D (${pct(g.hitRate)})`
    : 'nenhum sinal ainda';

  desenharRodadas();
  desenharLista();
  desenharPadroesSim();
}

function desenharRodadas() {
  $('#rodadas').innerHTML = estado.rodadas
    .map((r) => `<div class="pedra pedra--${r.color}" title="${new Date(r.createdAt).toLocaleTimeString('pt-BR')}">${r.roll === null ? EMOJI[r.color] : r.roll}</div>`)
    .join('');
}

function desenharLista() {
  const alvo = $('#lista');
  if (!estado.padroes.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum padrão ainda.<br>Cadastre o primeiro ao lado.</p>';
    return;
  }

  alvo.innerHTML = estado.padroes.map((p) => {
    const s = p.placar;
    const temDados = s.total > 0;
    // A cor vem do veredito calculado no servidor, que leva o tamanho da
    // amostra em conta. Comparar as duas taxas cruas, como antes, pintava de
    // verde um padrao com 12 acertos em 13 sinais (92,3%, mas intervalo de
    // 66,7% a 98,6%) ao lado de um com 1.219 em 1.552 — ou seja, destacava
    // justamente o padrao sobre o qual nao se sabe nada.
    const placar = temDados
      ? `<span class="${CLASSE_VEREDITO[p.veredito] || 'discreto'}">${pct(s.hitRate)}</span>
         <span class="rotulo rotulo--${p.veredito}">${TEXTO_VEREDITO[p.veredito] || ''}</span>
         <span class="discreto">${s.greens}V / ${s.reds}D · base ${pct(p.linhaDeBase)}
         · de ${pct(p.intervalo.baixo)} a ${pct(p.intervalo.alto)}</span>`
      : '<span class="discreto">sem sinal ainda</span>';

    return `
      <article class="padrao ${p.active ? '' : 'padrao--off'}" data-id="${p.id}">
        <div class="padrao__topo">
          <span class="padrao__nome">#${p.id} ${escapar(p.name)}</span>
          <span class="discreto">${p.active ? 'ativo' : 'pausado'}</span>
        </div>
        <div class="padrao__expr">${escapar(p.pretty)} → ${EMOJI[p.entryColor]}</div>
        <div class="padrao__meta">${p.gales === 0 ? 'sem gale' : 'até G' + p.gales} · ${NOME_BRANCO[p.whiteRule]}</div>
        <div class="padrao__placar">${placar}</div>
        <div class="padrao__acoes">
          <button class="botao" data-acao="editar">Editar</button>
          <button class="botao" data-acao="alternar">${p.active ? 'Pausar' : 'Ativar'}</button>
          <button class="botao" data-acao="testar">Testar</button>
          <button class="botao" data-acao="excluir">Excluir</button>
        </div>
      </article>`;
  }).join('');
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- acoes da lista ----------

$('#lista').addEventListener('click', async (e) => {
  const botao = e.target.closest('button[data-acao]');
  if (!botao) return;
  const id = Number(botao.closest('.padrao').dataset.id);
  const p = estado.padroes.find((x) => x.id === id);
  if (!p) return;

  try {
    if (botao.dataset.acao === 'editar') {
      carregarNoEditor(p);
    } else if (botao.dataset.acao === 'alternar') {
      await api(`/padroes/${id}`, { method: 'PUT', body: { active: !p.active } });
      avisar(p.active ? `Padrão #${id} pausado` : `Padrão #${id} ativado`);
      await carregar();
    } else if (botao.dataset.acao === 'testar') {
      carregarNoEditor(p);
      await testar();
    } else if (botao.dataset.acao === 'excluir') {
      if (!confirm(`Excluir o padrão #${id} "${p.name}"?\n\nO histórico de sinais dele também sai.`)) return;
      await api(`/padroes/${id}`, { method: 'DELETE' });
      if (editandoId === id) limparEditor();
      avisar(`Padrão #${id} excluído`);
      await carregar();
    }
  } catch (err) {
    avisar(err.message);
  }
});

// ---------- editor ----------

function escolhido(grupo) {
  return document.querySelector(`input[name="${grupo}"]:checked`).value;
}

function marcar(grupo, valor) {
  const el = document.querySelector(`input[name="${grupo}"][value="${valor}"]`);
  if (el) el.checked = true;
}

function lerFormulario() {
  return {
    name: $('#p-nome').value.trim(),
    expr: $('#p-expr').value.trim(),
    entryColor: escolhido('entrada'),
    gales: Number(escolhido('gales')),
    whiteRule: escolhido('branco'),
  };
}

function carregarNoEditor(p) {
  editandoId = p.id;
  $('#p-nome').value = p.name;
  $('#p-expr').value = p.expr;
  // As aspas nao sao enfeite: [value=1] e seletor invalido, porque um
  // identificador CSS nao pode comecar com digito, e o querySelector lanca.
  marcar('entrada', p.entryColor);
  marcar('gales', p.gales);
  marcar('branco', p.whiteRule);
  $('#editor-titulo').textContent = `Editando #${p.id}`;
  $('#btn-salvar').textContent = 'Salvar alterações';
  $('#btn-limpar').hidden = false;
  mostrarErro('#erro-padrao', '');
  $('#resultado-teste').hidden = true;
  atualizarPrevia();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function limparEditor() {
  editandoId = null;
  $('#form-padrao').reset();
  $('#editor-titulo').textContent = 'Novo padrão';
  $('#btn-salvar').textContent = 'Salvar padrão';
  $('#btn-limpar').hidden = true;
  $('#resultado-teste').hidden = true;
  mostrarErro('#erro-padrao', '');
  $('#previa-expr').hidden = true;
}

$('#btn-limpar').addEventListener('click', limparEditor);

// atalhos que montam o gatilho
document.querySelectorAll('[data-add]').forEach((b) => {
  b.addEventListener('click', () => acrescentar(b.dataset.add));
});

function acrescentar(txt) {
  const campo = $('#p-expr');
  campo.value = (campo.value.trim() + ' ' + txt).trim();
  campo.focus();
  atualizarPrevia();
}

$('#btn-apagar-expr').addEventListener('click', () => {
  $('#p-expr').value = '';
  $('#p-expr').focus();
  atualizarPrevia();
});

// ---------- previa do gatilho em pedras ----------
// O campo continua sendo texto, porque e ali que cabem "*{4}", "[1,5,9]" e "!0".
// A leitura em bolinhas fica embaixo dele — e quem traduz e o servidor, para o
// painel nunca mostrar uma sequencia diferente da que o motor vai casar.

const previa = $('#previa-expr');
let previaSeq = 0;

function pintarPrevia(texto, erro) {
  previa.className = erro ? 'previa previa--erro' : 'previa';
  previa.textContent = texto;
  previa.hidden = false;
}

async function atualizarPrevia() {
  const expr = $('#p-expr').value.trim();
  if (!expr) { previa.hidden = true; return; }
  const meu = ++previaSeq;
  try {
    const r = await api('/previa', { method: 'POST', body: { expr } });
    if (meu !== previaSeq) return;   // resposta velha chegou depois: ignora
    pintarPrevia(`${r.pretty}  →  ${EMOJI[escolhido('entrada')]}`, false);
  } catch (err) {
    if (meu !== previaSeq) return;
    pintarPrevia(err.message, true);
  }
}

let previaTimer = null;
function previaAtrasada() {
  clearTimeout(previaTimer);
  previaTimer = setTimeout(atualizarPrevia, 250);
}

$('#p-expr').addEventListener('input', previaAtrasada);
document.querySelectorAll('input[name="entrada"]').forEach((r) => {
  r.addEventListener('change', () => { if (!previa.hidden) atualizarPrevia(); });
});

// teclado de pedras 0..14
const teclado = $('#teclado-pedras');
teclado.innerHTML = Array.from({ length: 15 }, (_, n) => {
  const cor = n === 0 ? 'B' : n <= 7 ? 'A' : 'P';
  return `<button type="button" class="pedra pedra--${cor}" data-pedra="${n}">${n}</button>`;
}).join('');

$('#btn-pedras').addEventListener('click', () => { teclado.hidden = !teclado.hidden; });
teclado.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pedra]');
  if (b) acrescentar(b.dataset.pedra);
});

$('#btn-espera').addEventListener('click', () => {
  const n = prompt('Entrar quantas casas depois do gatilho?\n\n1 = entra na próxima rodada\n5 = entra na quinta rodada depois', '5');
  if (n === null) return;
  const casas = Number(n);
  if (!Number.isInteger(casas) || casas < 1 || casas > 50) {
    avisar('Informe um número de 1 a 50.');
    return;
  }
  acrescentar(`apos ${casas} casas`);
});

// ---------- testar e salvar ----------

async function testar() {
  const dados = lerFormulario();
  if (!dados.expr) { mostrarErro('#erro-padrao', 'Escreva o gatilho antes de testar.'); return; }

  const botao = $('#btn-testar');
  botao.disabled = true;
  botao.textContent = 'Testando…';
  mostrarErro('#erro-padrao', '');

  try {
    const r = await api('/testar', { method: 'POST', body: dados });
    desenharTeste(r, dados);
  } catch (err) {
    mostrarErro('#erro-padrao', err.message);
    $('#resultado-teste').hidden = true;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Testar no histórico';
  }
}

$('#btn-testar').addEventListener('click', testar);

function desenharTeste(r, dados) {
  const alvo = $('#resultado-teste');

  if (r.signals === 0) {
    alvo.innerHTML = `
      <div class="teste__taxa">—</div>
      <div class="teste__linhas">
        <span><strong>${escapar(r.pretty)}</strong> → ${EMOJI[dados.entryColor]}</span>
        <span>Esse padrão não apareceu nenhuma vez nas <strong>${r.roundsScanned.toLocaleString('pt-BR')}</strong> rodadas guardadas.</span>
        <span>Quanto mais histórico o robô acumular, mais confiável fica o teste.</span>
      </div>`;
    alvo.hidden = false;
    return;
  }

  const diferenca = r.hitRate - r.linhaDeBase;
  // Com poucos sinais a diferenca e ruido; so chamamos de vantagem acima de
  // 3 pontos com amostra decente. Esta e a parte honesta do painel.
  let classe = 'igual';
  let veredito;
  if (r.signals < 30) {
    veredito = `Amostra pequena (${r.signals} sinais). Ainda não dá para concluir nada — espere o padrão aparecer mais vezes.`;
  } else if (diferenca > 0.03) {
    classe = 'acima';
    veredito = `Está <strong>${(diferenca * 100).toFixed(1).replace('.', ',')} pontos acima</strong> do que uma entrada sem padrão nenhum daria (${pct(r.linhaDeBase)}).`;
  } else if (diferenca < -0.03) {
    classe = 'abaixo';
    veredito = `Está <strong>${(Math.abs(diferenca) * 100).toFixed(1).replace('.', ',')} pontos abaixo</strong> da entrada sem padrão (${pct(r.linhaDeBase)}).`;
  } else {
    veredito = `Praticamente igual a uma entrada sem padrão nenhum (${pct(r.linhaDeBase)}). O gatilho não está mudando o resultado — quem segura o número é o gale e a regra do branco.`;
  }

  const porGale = r.greenByGale
    .map((n, i) => (n ? `G${i}: ${n}` : null))
    .filter(Boolean)
    .concat(r.greenWhite ? [`branco: ${r.greenWhite}`] : [])
    .join(' · ');

  alvo.innerHTML = `
    <div class="teste__taxa">${pct(r.hitRate)}</div>
    <div class="teste__linhas">
      <span><strong>${escapar(r.pretty)}</strong> → ${EMOJI[dados.entryColor]} ${NOME_COR[dados.entryColor]}</span>
      <span>Apareceu <strong>${r.signals}</strong> vezes em <strong>${r.roundsScanned.toLocaleString('pt-BR')}</strong> rodadas</span>
      <span><strong class="verde">${r.greens} GREEN</strong> · <strong class="vermelho">${r.reds} RED</strong>${porGale ? ' · ' + porGale : ''}</span>
      <span>Melhor sequência: <strong>${r.bestGreenStreak}</strong> greens · pior: <strong>${r.worstRedStreak}</strong> reds</span>
    </div>
    <div class="veredito veredito--${classe}">${veredito}</div>`;
  alvo.hidden = false;
}

$('#form-padrao').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = lerFormulario();
  const botao = $('#btn-salvar');
  botao.disabled = true;
  mostrarErro('#erro-padrao', '');

  try {
    if (editandoId === null) {
      const p = await api('/padroes', { method: 'POST', body: dados });
      avisar(`Padrão #${p.id} criado`);
      limparEditor();
    } else {
      await api(`/padroes/${editandoId}`, { method: 'PUT', body: dados });
      avisar(`Padrão #${editandoId} atualizado`);
      limparEditor();
    }
    await carregar();
  } catch (err) {
    mostrarErro('#erro-padrao', err.message);
  } finally {
    botao.disabled = false;
  }
});

// ---------- modo de alerta ----------

$('#btn-modo').addEventListener('click', async () => {
  const novo = estado.modo === 'publico' ? 'completo' : 'publico';
  const aviso = novo === 'publico'
    ? 'Ocultar a estratégia nos alertas?\n\nQuem receber verá só "Sinal #id", a cor de entrada e o placar — sem o nome do padrão e sem a sequência do gatilho.'
    : 'Voltar a mostrar a estratégia nos alertas?\n\nO nome do padrão e a sequência do gatilho voltam a aparecer para quem recebe.';
  if (!confirm(aviso)) return;
  try {
    await api('/modo', { method: 'POST', body: { modo: novo } });
    await carregar();
    avisar(novo === 'publico' ? 'Estratégia oculta nos alertas' : 'Estratégia visível nos alertas');
  } catch (err) {
    avisar(err.message);
  }
});

// ---------- abas ----------

function abrirAba(nome) {
  for (const b of document.querySelectorAll('.aba')) {
    b.classList.toggle('aba--ativa', b.dataset.aba === nome);
  }
  $('#aba-padroes').hidden = nome !== 'padroes';
  $('#aba-simulador').hidden = nome !== 'simulador';
}

$('#abas').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-aba]');
  if (b) abrirAba(b.dataset.aba);
});

// ---------- simulador de banca ----------

/**
 * Tabelas prontas.
 *
 * A de 6 niveis e a que o cliente desenhou, com a entrada minima de R$ 0,10 da
 * plataforma. O gale classico esta aqui ao lado de proposito: serve para ver
 * na tela que dobrar e so um caso particular de tabela, e que o numero do
 * rodape nao muda por causa dela.
 */
const PRESETS_ESCADA = {
  cliente: [
    { entrada: 0.76, branco: 0.1 },
    { entrada: 1.73, branco: 0.2 },
    { entrada: 3.97, branco: 0.52 },
    { entrada: 9.22, branco: 1.27 },
    { entrada: 21.45, branco: 3.02 },
    { entrada: 50, branco: 7.1 },
  ],
  dobro: [
    { entrada: 1, branco: 0.1 },
    { entrada: 2, branco: 0.2 },
    { entrada: 4, branco: 0.4 },
  ],
  seco: [{ entrada: 1, branco: 0.1 }],
};

let escada = PRESETS_ESCADA.cliente.map((d) => ({ ...d }));

function brl(v) {
  const n = Number(v) || 0;
  return (n < 0 ? '-R$ ' : 'R$ ') + Math.abs(n).toFixed(2).replace('.', ',');
}

/** "1 em 97" diz mais que "1,03%" para quem vai apostar de verdade. */
function umEm(p) {
  if (!p || p <= 0) return 'nunca';
  return '1 em ' + Math.round(1 / p).toLocaleString('pt-BR');
}

function desenharEscada() {
  let soma = 0;
  $('#escada-corpo').innerHTML = escada.map((d, i) => {
    soma += (Number(d.entrada) || 0) + (Number(d.branco) || 0);
    const rotulo = i === 0 ? 'Seca' : 'G' + i;
    return `
      <tr data-i="${i}">
        <td><strong>${i + 1}</strong> <span class="discreto">${rotulo}</span></td>
        <td><input type="number" class="mini" min="0.1" step="0.01" value="${d.entrada}" data-campo="entrada"></td>
        <td><input type="number" class="mini" min="0" step="0.01" value="${d.branco}" data-campo="branco"></td>
        <td class="discreto">${brl(soma)}</td>
        <td><button type="button" class="chip chip--apagar" data-remover="${i}">×</button></td>
      </tr>`;
  }).join('');
  $('#escada-total').textContent = brl(soma);
}

$('#escada-corpo').addEventListener('input', (e) => {
  const campo = e.target.dataset.campo;
  if (!campo) return;
  const i = Number(e.target.closest('tr').dataset.i);
  escada[i][campo] = e.target.value === '' ? 0 : Number(e.target.value);
  // Redesenhar inteiro tiraria o foco do campo a cada tecla; so o acumulado
  // precisa acompanhar a digitacao.
  let soma = 0;
  const linhas = $('#escada-corpo').children;
  for (let k = 0; k < escada.length; k++) {
    soma += (Number(escada[k].entrada) || 0) + (Number(escada[k].branco) || 0);
    linhas[k].children[3].textContent = brl(soma);
  }
  $('#escada-total').textContent = brl(soma);
});

$('#escada-corpo').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-remover]');
  if (!b) return;
  if (escada.length <= 1) { avisar('A tabela precisa de pelo menos um degrau.'); return; }
  escada.splice(Number(b.dataset.remover), 1);
  desenharEscada();
});

$('#btn-degrau-mais').addEventListener('click', () => {
  if (escada.length >= 12) { avisar('A tabela aceita no máximo 12 degraus.'); return; }
  // O degrau novo nasce dobrando o anterior porque e o chute mais util: e o
  // valor que empata o prejuizo da escada se ela ganhar ali.
  const ultimo = escada[escada.length - 1];
  escada.push({
    entrada: Math.round(ultimo.entrada * 2 * 100) / 100,
    branco: Math.round(ultimo.branco * 2 * 100) / 100,
  });
  desenharEscada();
});

$('#btn-degrau-menos').addEventListener('click', () => {
  if (escada.length <= 1) { avisar('A tabela precisa de pelo menos um degrau.'); return; }
  escada.pop();
  desenharEscada();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-preset]');
  if (!b) return;
  escada = PRESETS_ESCADA[b.dataset.preset].map((d) => ({ ...d }));
  desenharEscada();
});

/**
 * Lista de padroes do simulador.
 *
 * Vem marcada igual ao robo ao vivo (os ativos), para a primeira simulacao
 * responder "o que a minha configuracao de agora faz" sem ninguem mexer em nada.
 */
function desenharPadroesSim() {
  const alvo = $('#s-padroes');
  if (!estado || !estado.padroes.length) {
    alvo.innerHTML = '<p class="vazio">Cadastre um padrão primeiro.</p>';
    return;
  }
  const marcados = new Set(
    [...alvo.querySelectorAll('input:checked')].map((i) => Number(i.value)),
  );
  const primeiraVez = alvo.dataset.pronto !== '1';
  alvo.dataset.pronto = '1';

  alvo.innerHTML = estado.padroes.map((p) => {
    const on = primeiraVez ? p.active : marcados.has(p.id);
    return `<label><input type="checkbox" value="${p.id}"${on ? ' checked' : ''}>
      <span class="opcao">#${p.id} ${escapar(p.name)} → ${EMOJI[p.entryColor]}
      <em class="discreto">${p.active ? '' : '(pausado) '}${NOME_BRANCO[p.whiteRule]}</em></span></label>`;
  }).join('');
}

function lerPedidoSim() {
  const n = (sel) => {
    const v = $(sel).value;
    return v === '' ? null : Number(v);
  };
  return {
    escada: escada.map((d) => ({ entrada: Number(d.entrada), branco: Number(d.branco) })),
    bancaInicial: Number($('#s-banca').value),
    meta: n('#s-meta'),
    horarioInicio: n('#s-hora-ini'),
    horarioFim: n('#s-hora-fim'),
    diasControle: Number($('#s-dias').value || 0),
    seed: Number($('#s-seed').value || 1),
    pararNoPrimeiroRed: $('#s-parar').checked,
    umaEscadaPorVez: $('#s-uma').checked,
    resetarNoBranco: $('#s-reset').checked,
    padroes: [...$('#s-padroes').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  };
}

$('#btn-simular').addEventListener('click', async () => {
  const botao = $('#btn-simular');
  botao.disabled = true;
  mostrarErro('#erro-sim', '');
  $('#sim-andando').hidden = false;
  try {
    const d = await api('/simular', { method: 'POST', body: lerPedidoSim() });
    desenharTeoria(d.teoria, d.teoriaVale, d.teoriaDe);
    desenharResultadoSim(d);
    $('#sim-resultado').hidden = false;
  } catch (err) {
    mostrarErro('#erro-sim', err.message);
  } finally {
    botao.disabled = false;
    $('#sim-andando').hidden = true;
  }
});

function desenharTeoria(t, vale, de) {
  // A margem fecha o cartao de proposito: e o unico numero da tela que nenhuma
  // tabela muda, e e ele que explica todos os outros.
  $('#teoria').innerHTML = `
    <dl class="teoria__lista">
      <div><dt>A escada inteira custa</dt><dd>${brl(t.acumulado)}</dd></div>
      <div><dt>Ganhando, cada escada rende</dt><dd class="verde">${brl(t.lucroQuandoGanha)}</dd></div>
      <div><dt>Perdendo, cada escada custa</dt><dd class="vermelho">${brl(t.perdaQuandoPerde)}</dd></div>
      <div><dt>Perde a escada inteira</dt><dd>${umEm(t.chanceDePerder)} <span class="discreto">(${pct(t.chanceDePerder)})</span></dd></div>
      <div><dt>Escadas ganhas que a meta exige</dt><dd>${t.ciclosParaMeta.toLocaleString('pt-BR')} <span class="discreto">seguidas</span></dd></div>
      <div><dt>Chance de o dia bater a meta</dt><dd><strong>${pct(t.chanceDeBaterMeta)}</strong></dd></div>
      <div><dt>Dias na meta para empatar</dt><dd><strong>${pct(t.chanceParaEmpatar)}</strong></dd></div>
      <div><dt>Margem da casa sobre o girado</dt><dd class="vermelho">${pct(t.margem)}</dd></div>
    </dl>
    ${vale === false ? `<p class="nota"><strong>Atenção:</strong> os números acima
      valem para o padrão <strong>#${de.id} ${escapar(de.name)}</strong>. Os outros
      padrões marcados têm regra de branco diferente, e a chance de cada degrau
      depende dela — compare pelas duas colunas do placar, não por esta conta.</p>` : ''}
    <p class="nota">
      Uma escada perdida leva a banca toda, então a meta exige
      <strong>${t.ciclosParaMeta.toLocaleString('pt-BR')} escadas ganhas sem perder nenhuma</strong>.
      É daí que sai a chance de ${pct(t.chanceDeBaterMeta)} — e ela precisaria ser
      ${pct(t.chanceParaEmpatar)} só para empatar.
    </p>`;
}

/** Uma linha do placar duplo. `melhor` diz de que lado o numero deveria estar. */
function linhaPlacar(rotulo, real, controle, dica) {
  return `<tr><th>${rotulo}${dica ? ` <em class="discreto">${dica}</em>` : ''}</th>
    <td>${real}</td><td>${controle}</td></tr>`;
}

function desenharResultadoSim(d) {
  const r = d.real;
  const c = d.controle;
  const vazio = '<span class="discreto">—</span>';
  const col = (x, fn) => (x ? fn(x) : vazio);

  const cor = (v) => `<span class="${v < 0 ? 'vermelho' : 'verde'}">${brl(v)}</span>`;
  const metas = (res) => {
    const ok = res.metasPorPerdaObtidas >= res.metasPorPerdaNecessarias;
    return `<span class="${ok ? 'verde' : 'vermelho'}">${res.metasPorPerdaObtidas.toFixed(2)}</span>
      <span class="discreto">de ${res.metasPorPerdaNecessarias.toFixed(2)}</span>`;
  };

  $('#sim-placar').innerHTML = `
    <table class="tabela">
      <thead><tr><th></th><th>Histórico real</th><th>Roleta honesta</th></tr></thead>
      <tbody>
        ${linhaPlacar('Dias simulados',
          col(r, (x) => x.resumo.dias.toLocaleString('pt-BR')),
          col(c, (x) => x.resumo.dias.toLocaleString('pt-BR')))}
        ${linhaPlacar('Dias na meta',
          col(r, (x) => `<strong>${pct(x.resumo.taxaNaMeta)}</strong> <span class="discreto">${x.resumo.diasNaMeta} dias</span>`),
          col(c, (x) => `<strong>${pct(x.resumo.taxaNaMeta)}</strong> <span class="discreto">${x.resumo.diasNaMeta} dias</span>`))}
        ${linhaPlacar('Precisaria bater',
          col(r, (x) => pct(x.resumo.taxaParaEmpatar)),
          col(c, (x) => pct(x.resumo.taxaParaEmpatar)), 'para empatar')}
        ${linhaPlacar('Metas por dia perdido',
          col(r, (x) => metas(x.resumo)),
          col(c, (x) => metas(x.resumo)))}
        ${linhaPlacar('Dia bom paga',
          col(r, (x) => cor(x.resumo.mediaDiaBom)),
          col(c, (x) => cor(x.resumo.mediaDiaBom)))}
        ${linhaPlacar('Dia ruim custa',
          col(r, (x) => cor(x.resumo.mediaDiaRuim)),
          col(c, (x) => cor(x.resumo.mediaDiaRuim)))}
        ${linhaPlacar('Média por dia',
          col(r, (x) => `<strong>${cor(x.resumo.mediaPorDia)}</strong>`),
          col(c, (x) => `<strong>${cor(x.resumo.mediaPorDia)}</strong>`))}
        ${linhaPlacar('Resultado do período',
          col(r, (x) => cor(x.resumo.resultado)),
          col(c, (x) => cor(x.resumo.resultado)))}
        ${linhaPlacar('Girado na plataforma',
          col(r, (x) => brl(x.apostado)),
          col(c, (x) => brl(x.apostado)))}
        ${linhaPlacar('Margem sobre o girado',
          col(r, (x) => `<span class="vermelho">${pct(x.margemDaCasa)}</span>`),
          col(c, (x) => `<span class="vermelho">${pct(x.margemDaCasa)}</span>`))}
      </tbody>
    </table>`;

  const banca = Number($('#s-banca').value) || 0;
  $('#sim-curva').innerHTML = r ? svgCurva(r.curva, banca) : '';
  $('#sim-curva-legenda').textContent = r
    ? `${r.giros.toLocaleString('pt-BR')} giros · ${r.entradas.toLocaleString('pt-BR')} escadas`
    : '';

  // As barras saem do controle quando ele existe: mil dias mostram as duas
  // pilhas, e 27 dias de historico nao mostram pilha nenhuma.
  const dias = c ? c.resultadosPorDia : (r ? r.resultadosPorDia : []);
  $('#sim-dias').innerHTML = svgBarras(dias);
  $('#sim-dias-nota').innerHTML = dias.length
    ? `${dias.length.toLocaleString('pt-BR')} dias ${c ? 'de roleta honesta' : 'do histórico real'}.
       Repare que quase nenhum dia cai perto da média: os dias são ou de meta batida
       ou de banca perdida, e é a proporção entre as duas pilhas que decide o mês.`
    : '';

  $('#sim-sessoes').innerHTML = r ? r.sessoes.map((s) => `
    <tr>
      <td>${s.inicioEm ? new Date(s.inicioEm).toLocaleDateString('pt-BR') : '—'}</td>
      <td>${s.entradas}</td>
      <td class="${s.resultado < 0 ? 'vermelho' : 'verde'}">${brl(s.resultado)}</td>
      <td class="discreto">${brl(s.melhorResultado)}</td>
      <td><span class="selo selo--${MOTIVO_CLASSE[s.motivo] || 'neutro'}">${MOTIVO_TEXTO[s.motivo] || s.motivo}</span></td>
    </tr>`).join('') : '';

  $('#sim-extrato').innerHTML = r ? r.extrato.slice().reverse().map((e) => `
    <tr>
      <td class="discreto">${new Date(e.em).toLocaleString('pt-BR')}</td>
      <td>#${e.patternId} ${EMOJI[e.entryColor]}</td>
      <td>${e.gale === 0 ? 'seca' : 'G' + e.gale}</td>
      <td>${brl(e.apostado)}</td>
      <td class="${e.lucro < 0 ? 'vermelho' : 'verde'}">${brl(e.lucro)}${e.noBranco ? ' ⚪' : ''}</td>
      <td class="discreto">${brl(e.saldo)}</td>
    </tr>`).join('') : '';
}

const MOTIVO_TEXTO = {
  stopWin: 'meta batida',
  stopLoss: 'limite',
  quebrou: 'banca quebrou',
  fimDoDia: 'dia acabou',
  fimDoHistorico: 'em aberto',
  recuperado: 'recuperou',
  recuperacaoFalhou: 'recuperação falhou',
  escadaPerdida: 'escada perdida',
};
const MOTIVO_CLASSE = {
  stopWin: 'ok',
  recuperado: 'ok',
  stopLoss: 'ruim',
  quebrou: 'ruim',
  escadaPerdida: 'ruim',
  recuperacaoFalhou: 'ruim',
};

/**
 * Curva de saldo em SVG.
 *
 * SVG na mao em vez de biblioteca de grafico: sao duas formas e uma linha de
 * referencia, e o painel roda num VPS pequeno atras do nginx — nao vale puxar
 * 300 KB de dependencia para desenhar uma polilinha. `vector-effect` mantem o
 * traco fino mesmo com o viewBox esticado na largura da tela.
 */
function svgCurva(pontos, banca) {
  if (!pontos || pontos.length < 2) {
    return '<p class="vazio">Sem apostas suficientes para desenhar a curva.</p>';
  }
  const L = 1000;
  const A = 220;
  const vs = pontos.map((p) => p.saldo);
  let min = Math.min(...vs, banca);
  let max = Math.max(...vs, banca);
  if (max - min < 1) { max = min + 1; }
  const folga = (max - min) * 0.08;
  min -= folga;
  max += folga;
  const x = (i) => (i / (pontos.length - 1)) * L;
  const y = (v) => A - ((v - min) / (max - min)) * A;

  const linha = pontos.map((p, i) => `${x(i).toFixed(1)},${y(p.saldo).toFixed(1)}`).join(' ');
  const area = `0,${A} ${linha} ${L},${A}`;
  const yBanca = y(banca).toFixed(1);

  return `
    <svg class="grafico__svg" viewBox="0 0 ${L} ${A}" preserveAspectRatio="none" role="img"
         aria-label="Curva de saldo da simulação">
      <polygon points="${area}" class="curva__area"></polygon>
      <line x1="0" y1="${yBanca}" x2="${L}" y2="${yBanca}" class="curva__base"
            vector-effect="non-scaling-stroke"></line>
      <polyline points="${linha}" class="curva__linha" vector-effect="non-scaling-stroke"></polyline>
    </svg>
    <div class="grafico__eixo">
      <span>${brl(min)}</span>
      <span class="discreto">linha da banca: ${brl(banca)}</span>
      <span>${brl(max)}</span>
    </div>`;
}

/** Uma barra por dia: verde para cima, vermelha para baixo, zero no meio. */
function svgBarras(valores) {
  if (!valores || !valores.length) {
    return '<p class="vazio">Sem dias fechados para mostrar.</p>';
  }
  const L = 1000;
  const A = 200;
  const topo = Math.max(1, ...valores.map(Math.abs));
  const meio = A / 2;
  const larg = L / valores.length;
  const barras = valores.map((v, i) => {
    const h = (Math.abs(v) / topo) * (A / 2);
    const yTopo = v >= 0 ? meio - h : meio;
    return `<rect x="${(i * larg).toFixed(2)}" y="${yTopo.toFixed(2)}"
      width="${Math.max(larg - 0.4, 0.4).toFixed(2)}" height="${Math.max(h, 0.5).toFixed(2)}"
      class="${v >= 0 ? 'barra--verde' : 'barra--vermelha'}"></rect>`;
  }).join('');

  return `
    <svg class="grafico__svg" viewBox="0 0 ${L} ${A}" preserveAspectRatio="none" role="img"
         aria-label="Resultado de cada dia simulado">
      ${barras}
      <line x1="0" y1="${meio}" x2="${L}" y2="${meio}" class="curva__base"
            vector-effect="non-scaling-stroke"></line>
    </svg>
    <div class="grafico__eixo">
      <span>${brl(-topo)}</span>
      <span class="discreto">zero</span>
      <span>${brl(topo)}</span>
    </div>`;
}

desenharEscada();

// ---------- inicio ----------

(async function iniciar() {
  try {
    estado = await api('/estado');
    mostrarPainel();
    desenhar();
  } catch {
    mostrarLogin();
  }
})();

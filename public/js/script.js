// ==========================================
// SISTEMA DE CONTROLE DE EQUIPAMENTOS
// VERSÃO POSTGRESQL
// ==========================================
const API_BASE = ''; // Mesma origem
const TIPOS_EQUIPAMENTO = {
  1: 'Chromebook',
  2: 'Positivo',
  3: 'Tablet'
};
const PERIODOS = {
  manha: 'Manhã',
  tarde: 'Tarde',
  noite: 'Noite'
};
const AULAS = {
  1: '1ª Aula', 2: '2ª Aula', 3: '3ª Aula',
  4: '4ª Aula', 5: '5ª Aula', 6: '6ª Aula'
};
const EQUIP_MAP = {
  1: { disp: 'dispChromebook', total: 'totalChromebook', bar: 'barChromebook' },
  2: { disp: 'dispPositivo', total: 'totalPositivo', bar: 'barPositivo' },
  3: { disp: 'dispTablet', total: 'totalTablet', bar: 'barTablet' }
};

const REFRESH_MS = 60 * 1000; // auto-atualização a cada 1 minuto

let filtroAtual = 'todos';
let termoBusca = '';
let isAdmin = false;
let aulasSelecionadas = new Set();

// Estoque vindo do banco: { 1: {disp, total}, 2: {...}, 3: {...} }
let estoque = {};
let estoqueOk = false;       // true só quando a última consulta ao banco deu certo
let avisoEstoqueMostrado = false;
let enviando = false;        // evita duplo clique no envio

// ==========================================
// UTILIDADES
// ==========================================
function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  aplicarTema();
  inicializarEventos();
  verificarSessao();
  atualizarTelaCompleta();

  // Auto-atualização periódica
  setInterval(atualizarTelaCompleta, REFRESH_MS);

  // Ao voltar para a aba, atualiza na hora
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) atualizarTelaCompleta();
  });
});

function inicializarEventos() {
  document.querySelectorAll('.tipo-btn').forEach(btn => {
    btn.addEventListener('click', () => selecionarTipo(btn));
  });
  document.querySelectorAll('.periodo-btn').forEach(btn => {
    btn.addEventListener('click', () => selecionarPeriodo(btn));
  });
  document.querySelectorAll('.aula-btn').forEach(btn => {
    btn.addEventListener('click', () => selecionarAula(btn));
  });
  document.querySelectorAll('.filtro-btn').forEach(btn => {
    btn.addEventListener('click', () => filtrarHistorico(btn));
  });

  // Validação de nome sem números
  const inputResp = document.getElementById('responsavel');
  inputResp.addEventListener('input', function () {
    this.value = this.value.replace(/[0-9]/g, '');
    this.classList.remove('field-invalid');
  });
  inputResp.addEventListener('keypress', function (e) {
    if (/[0-9]/.test(e.key)) {
      e.preventDefault();
      mostrarToast('Números não são permitidos no nome.', 'error');
    }
  });

  document.getElementById('quantidade')?.addEventListener('input', function () {
    this.classList.remove('field-invalid');
  });

  // Busca
  const inputBusca = document.getElementById('buscaHistorico');
  if (inputBusca) {
    let debounce;
    inputBusca.addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        termoBusca = e.target.value.trim();
        carregarRegistros();
      }, 300);
    });
  }

  // Enter no login
  document.getElementById('senhaAdmin')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') tentarLogin();
  });

  // Ouvinte para Devolução (Total ou Parcial) — seguro contra apóstrofos e aspas
  const listaAtivos = document.getElementById('listaAtivos');
  if (listaAtivos) {
    listaAtivos.addEventListener('click', (e) => {
      const btnTudo = e.target.closest('.btn-devolver-tudo');
      if (btnTudo) {
        devolucaoRapida(btnTudo.dataset.tipo, btnTudo.dataset.qtd, btnTudo.dataset.resp);
        return;
      }

      const btnParcial = e.target.closest('.btn-devolver-parcial');
      if (btnParcial) {
        const card = btnParcial.closest('.registro-item');
        const form = card.querySelector('.parcial-form');
        form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
        if (form.style.display === 'flex') {
          const input = form.querySelector('.input-parcial');
          input.value = '';
          input.focus();
        }
        return;
      }

      const btnCancelar = e.target.closest('.btn-cancelar-parcial');
      if (btnCancelar) {
        btnCancelar.closest('.parcial-form').style.display = 'none';
        return;
      }

      const btnConfirmar = e.target.closest('.btn-confirmar-parcial');
      if (btnConfirmar) {
        const card = btnConfirmar.closest('.registro-item');
        const form = card.querySelector('.parcial-form');
        const input = form.querySelector('.input-parcial');
        const max = parseInt(input.max);
        const valor = parseInt(input.value);

        if (!valor || valor < 1) {
          return mostrarToast('Informe uma quantidade válida.', 'error');
        }
        if (valor > max) {
          return mostrarToast(`Quantidade maior que o disponível para devolução (${max}).`, 'error');
        }

        devolucaoRapida(btnConfirmar.dataset.tipo, valor, btnConfirmar.dataset.resp);
        form.style.display = 'none';
      }
    });
  }
}

// ==========================================
// CHAMADAS À API
// ==========================================
function tokenAdmin() {
  return sessionStorage.getItem('tokenAdmin');
}

async function apiFetch(endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = tokenAdmin();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* resposta sem JSON */
  }

  if (!res.ok) {
    // Sessão de admin expirada ou inválida
    if (res.status === 401 && token) {
      sessionStorage.removeItem('tokenAdmin');
      verificarSessao();
      throw new Error('Sessão expirada. Entre novamente como administrador.');
    }
    throw new Error((data && data.error) || `Erro ${res.status} ao acessar o servidor.`);
  }
  return data;
}

function apiGet(endpoint) {
  return apiFetch(endpoint);
}

function apiPost(endpoint, body) {
  return apiFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function apiDelete(endpoint) {
  return apiFetch(endpoint, { method: 'DELETE' });
}

// ==========================================
// INVENTÁRIO (sempre vindo do banco)
// ==========================================
function mostrarEstoqueIndisponivel() {
  Object.values(EQUIP_MAP).forEach(ids => {
    const dispEl = document.getElementById(ids.disp);
    const totalEl = document.getElementById(ids.total);
    const barEl = document.getElementById(ids.bar);
    if (dispEl) dispEl.textContent = '–';
    if (totalEl) totalEl.textContent = '–';
    if (barEl) {
      barEl.style.width = '0%';
      barEl.classList.remove('status-low');
      barEl.classList.add('status-empty');
    }
  });
  const hint = document.getElementById('hintDisp');
  if (hint) hint.textContent = 'Estoque indisponível no momento.';
}

async function carregarInventario() {
  try {
    const dados = await apiGet(`/api/inventario?_=${Date.now()}`);
    if (!Array.isArray(dados)) throw new Error('Resposta inesperada do servidor.');

    const novo = {};
    dados.forEach(item => {
      const tipo = Number(item.tipo_codigo);
      const ids = EQUIP_MAP[tipo];
      if (!ids) return;

      const total = Number(item.quantidade_total);
      let disponivel = Number(item.disponivel);
      if (disponivel < 0 || disponivel > total) {
        console.warn('Estoque inconsistente no banco para o tipo', tipo, item);
        disponivel = Math.max(0, Math.min(total, disponivel));
      }
      novo[tipo] = { disp: disponivel, total };

      const dispEl = document.getElementById(ids.disp);
      const totalEl = document.getElementById(ids.total);
      const barEl = document.getElementById(ids.bar);

      if (dispEl) dispEl.textContent = disponivel;
      if (totalEl) totalEl.textContent = total;

      if (barEl) {
        const pct = total > 0 ? Math.max(0, Math.min(100, (disponivel / total) * 100)) : 0;
        barEl.style.width = `${pct}%`;
        barEl.classList.remove('status-low', 'status-empty');
        if (pct === 0) barEl.classList.add('status-empty');
        else if (pct <= 30) barEl.classList.add('status-low');
      }
    });

    estoque = novo;
    estoqueOk = true;
    avisoEstoqueMostrado = false;

    // Atualiza o texto/limite do campo quantidade se um equipamento já estiver selecionado
    const tipoSel = document.getElementById('tipoEquipamento').value;
    if (tipoSel) atualizarHintDisponivel(tipoSel);
  } catch (err) {
    console.error('Erro ao carregar inventário:', err);
    estoqueOk = false;
    estoque = {};
    mostrarEstoqueIndisponivel();
    if (!avisoEstoqueMostrado) {
      avisoEstoqueMostrado = true;
      mostrarToast('Não foi possível carregar o estoque do servidor. Tentando novamente...', 'error');
    }
  }
}

function atualizarHintDisponivel(tipo) {
  const hint = document.getElementById('hintDisp');
  const qtdInput = document.getElementById('quantidade');
  const info = estoque[tipo];
  if (!info) {
    hint.textContent = 'Estoque indisponível no momento.';
    qtdInput.removeAttribute('max');
    return;
  }
  hint.textContent = `Disponível: ${info.disp} de ${info.total} ${TIPOS_EQUIPAMENTO[tipo]}`;
  qtdInput.max = info.disp;
}

// ==========================================
// SELEÇÕES
// ==========================================
function selecionarTipo(btn) {
  document.querySelectorAll('.tipo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('tipoEquipamento').value = btn.dataset.tipo;
  document.querySelector('.tipo-selector')?.classList.remove('field-invalid');
  atualizarHintDisponivel(btn.dataset.tipo);
}

function selecionarPeriodo(btn) {
  document.querySelectorAll('.periodo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('periodo').value = btn.dataset.periodo;
  document.querySelector('.periodo-selector')?.classList.remove('field-invalid');
}

function selecionarAula(btn) {
  const aula = btn.dataset.aula;
  if (aulasSelecionadas.has(aula)) {
    aulasSelecionadas.delete(aula);
    btn.classList.remove('selected');
  } else {
    aulasSelecionadas.add(aula);
    btn.classList.add('selected');
  }
  document.getElementById('aula').value = Array.from(aulasSelecionadas).join(',');
  if (aulasSelecionadas.size > 0) {
    document.querySelector('.aula-selector')?.classList.remove('field-invalid');
  }
}

function limparCamposInvalidos() {
  document.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
}

// ==========================================
// ATUALIZAÇÃO GERAL DA TELA
// ==========================================
async function atualizarTelaCompleta() {
  try {
    await Promise.all([carregarInventario(), carregarRetiradasAtivas()]);
    if (isAdmin) await carregarRegistros();
  } catch (err) {
    console.error('Erro ao atualizar tela:', err);
  }
}

// ==========================================
// REGISTRAR RETIRADA / DEVOLUÇÃO
// ==========================================
async function registrarRetirada() {
  if (enviando) return;

  const tipo = document.getElementById('tipoEquipamento').value;
  const quantidadeInput = document.getElementById('quantidade');
  const quantidade = parseInt(quantidadeInput.value);
  const responsavelInput = document.getElementById('responsavel');
  const responsavel = responsavelInput.value.trim().replace(/\s+/g, ' ');
  const periodo = document.getElementById('periodo').value;
  const aulas = Array.from(aulasSelecionadas)
    .sort()
    .map(a => AULAS[a])
    .join(', ');

  limparCamposInvalidos();

  const faltando = [];
  const camposInvalidos = [];

  if (!tipo) {
    faltando.push('Equipamento');
    camposInvalidos.push(document.querySelector('.tipo-selector'));
  }
  if (!quantidade || quantidade < 1) {
    faltando.push('Quantidade');
    camposInvalidos.push(quantidadeInput);
  }
  if (!responsavel) {
    faltando.push('Professor responsável');
    camposInvalidos.push(responsavelInput);
  }
  if (!periodo) {
    faltando.push('Período');
    camposInvalidos.push(document.querySelector('.periodo-selector'));
  }
  if (aulasSelecionadas.size === 0) {
    faltando.push('Aula');
    camposInvalidos.push(document.querySelector('.aula-selector'));
  }

  if (faltando.length > 0) {
    camposInvalidos.forEach(el => el?.classList.add('field-invalid'));
    return mostrarToast(`Campo${faltando.length > 1 ? 's' : ''} faltando: ${faltando.join(', ')}.`, 'error');
  }
  if (/[0-9]/.test(responsavel) || responsavel.length < 3) {
    responsavelInput.classList.add('field-invalid');
    return mostrarToast('Nome inválido. Apenas letras, mínimo 3 caracteres.', 'error');
  }

  enviando = true;
  try {
    // Consulta o estoque atual no banco ANTES de enviar
    await carregarInventario();
    if (!estoqueOk || !estoque[tipo]) {
      return mostrarToast('Não foi possível consultar o estoque agora. Tente novamente em instantes.', 'error');
    }
    const disp = estoque[tipo].disp;
    if (quantidade > disp) {
      quantidadeInput.classList.add('field-invalid');
      return mostrarToast(
        disp === 0
          ? `Não há ${TIPOS_EQUIPAMENTO[tipo]} disponível no momento.`
          : `Só há ${disp} ${TIPOS_EQUIPAMENTO[tipo]}(s) disponível(is).`,
        'error'
      );
    }

    // O servidor valida de novo (é ele quem garante o limite)
    await apiPost('/api/registros', {
      tipo_equipamento: parseInt(tipo),
      tipo_registro: 'retirada',
      quantidade,
      responsavel,
      periodo: PERIODOS[periodo],
      aula: aulas
    });
    limparFormulario();
    mostrarToast(`Retirada registrada: ${quantidade}x ${TIPOS_EQUIPAMENTO[tipo]}`, 'success');
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast(err.message, 'error');
    atualizarTelaCompleta(); // mostra o número real do banco
  } finally {
    enviando = false;
  }
}

async function devolucaoRapida(tipo, quantidade, responsavel) {
  if (enviando) return;
  enviando = true;
  try {
    await apiPost('/api/registros', {
      tipo_equipamento: parseInt(tipo),
      tipo_registro: 'devolucao',
      quantidade: parseInt(quantidade),
      responsavel,
      periodo: 'Devolução',
      aula: 'N/A'
    });
    mostrarToast(`Devolução registrada: ${quantidade}x ${TIPOS_EQUIPAMENTO[tipo]}`, 'success');
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast(err.message, 'error');
    atualizarTelaCompleta();
  } finally {
    enviando = false;
  }
}

async function carregarRetiradasAtivas() {
  const container = document.getElementById('listaAtivos');
  try {
    const ativos = await apiGet(`/api/registros/ativos?_=${Date.now()}`);

    if (!Array.isArray(ativos) || ativos.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhuma retirada ativa no momento.</div>';
      return;
    }

    container.innerHTML = ativos.map(item => `
      <div class="registro-item retirada">
        <div class="registro-header">
          <span class="registro-tipo retirada">
            <svg class="icon"><use href="#icon-alert"/></svg>
            Em uso · ${esc(item.quantidade)}
          </span>
          <span class="registro-data">
            <svg class="icon"><use href="#icon-clock"/></svg>
            ${esc(formatarDataISO(item.data_hora))}
          </span>
        </div>
        <div class="registro-info">
          <span><strong>Equip:</strong> ${esc(item.tipo_nome)}</span>
          <span><strong>Resp:</strong> ${esc(item.responsavel)}</span>
          <span><strong>Período:</strong> ${esc(item.periodo)}</span>
          <span><strong>Aula:</strong> ${esc(item.aula)}</span>
        </div>
        <div class="registro-actions">
          <button class="btn btn-devolucao btn-devolver-tudo"
                  data-tipo="${esc(item.tipo_equipamento)}"
                  data-qtd="${esc(item.quantidade)}"
                  data-resp="${esc(item.responsavel)}">
            <svg class="icon"><use href="#icon-arrow-in"/></svg>
            Devolver tudo
          </button>
          <button class="btn btn-parcial btn-devolver-parcial"
                  data-tipo="${esc(item.tipo_equipamento)}"
                  data-qtd="${esc(item.quantidade)}"
                  data-resp="${esc(item.responsavel)}">
            <svg class="icon"><use href="#icon-percent"/></svg>
            Devolver parte
          </button>
        </div>
        <div class="parcial-form">
          <input type="number" class="input-parcial" min="1" max="${esc(item.quantidade)}" placeholder="Qtd (máx. ${esc(item.quantidade)})">
          <button class="btn-confirmar-parcial" data-tipo="${esc(item.tipo_equipamento)}" data-resp="${esc(item.responsavel)}">
            <svg class="icon"><use href="#icon-check"/></svg>
            Confirmar
          </button>
          <button class="btn-cancelar-parcial">
            <svg class="icon"><use href="#icon-x"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Erro ativos:', err);
    container.innerHTML = '<div class="empty-state">Erro ao carregar retiradas.</div>';
  }
}

// ==========================================
// HISTÓRICO (Admin)
// ==========================================
async function carregarRegistros() {
  if (!isAdmin) return;
  const container = document.getElementById('listaHistorico');
  try {
    const params = new URLSearchParams();
    if (filtroAtual !== 'todos') params.set('filtro', filtroAtual);
    if (termoBusca) params.set('busca', termoBusca);
    const resposta = await apiGet(`/api/registros?${params.toString()}`);
    const registros = Array.isArray(resposta) ? resposta : (Array.isArray(resposta?.data) ? resposta.data : null);

    if (!registros) {
      console.error('Resposta inesperada de /api/registros:', resposta);
      container.innerHTML = '<div class="empty-state">A API não retornou uma lista de registros.</div>';
      return;
    }

    if (registros.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhum registro encontrado.</div>';
      return;
    }

    container.innerHTML = registros.map(item => `
      <div class="registro-item ${item.tipo_registro === 'retirada' ? 'retirada' : 'devolucao'}">
        <div class="registro-header">
          <span class="registro-tipo ${item.tipo_registro === 'retirada' ? 'retirada' : 'devolucao'}">
            <svg class="icon"><use href="#icon-${item.tipo_registro === 'retirada' ? 'arrow-out' : 'arrow-in'}"/></svg>
            ${item.tipo_registro === 'retirada' ? 'Retirada' : 'Devolução'}
          </span>
          <span class="registro-data">
            <svg class="icon"><use href="#icon-clock"/></svg>
            ${esc(formatarDataISO(item.data_hora))}
          </span>
        </div>
        <div class="registro-info">
          <span><strong>Equip:</strong> ${esc(item.tipo_nome)}</span>
          <span><strong>Qtd:</strong> ${esc(item.quantidade)}</span>
          <span><strong>Resp:</strong> ${esc(item.responsavel)}</span>
          <span><strong>Período:</strong> ${esc(item.periodo)}</span>
          <span><strong>Aula:</strong> ${esc(item.aula)}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
    container.innerHTML = `<div class="empty-state">Erro ao carregar histórico: ${esc(err.message)}</div>`;
  }
}

function filtrarHistorico(btn) {
  document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filtroAtual = btn.dataset.filtro;
  carregarRegistros();
}

function limparBusca() {
  document.getElementById('buscaHistorico').value = '';
  termoBusca = '';
  carregarRegistros();
}

async function limparHistorico() {
  if (!confirm('Limpar TODO o histórico? Esta ação é irreversível.')) return;
  try {
    await apiDelete('/api/registros');
    mostrarToast('Histórico limpo.', 'info');
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast('Erro ao limpar: ' + err.message, 'error');
  }
}

// ==========================================
// IMPRESSÃO PDF
// ==========================================
function imprimirHistorico() {
  const panel = document.getElementById('panelHistorico');
  const header = document.createElement('div');
  header.className = 'print-header';
  header.innerHTML = `<h1>E.E. Luiz Bianconi</h1> <p><strong>Relatório de Controle de Equipamentos</strong></p> <p>Gerado em: ${esc(new Date().toLocaleString('pt-BR'))}</p>`;
  panel.insertBefore(header, panel.firstChild);
  window.print();
  setTimeout(() => header.remove(), 500);
}

// ==========================================
// LOGIN ADMIN
// ==========================================
function abrirModalLogin() {
  document.getElementById('modalLogin').style.display = 'flex';
  setTimeout(() => document.getElementById('senhaAdmin').focus(), 100);
}

function fecharModalLogin() {
  document.getElementById('modalLogin').style.display = 'none';
  document.getElementById('senhaAdmin').value = '';
}

async function tentarLogin() {
  const senha = document.getElementById('senhaAdmin').value;
  try {
    const resp = await apiPost('/api/login', { senha });
    if (!resp.token) throw new Error('Login sem token.');
    sessionStorage.setItem('tokenAdmin', resp.token);
    fecharModalLogin();
    verificarSessao();
    mostrarToast('Bem-vindo, administrador.', 'success');
  } catch (err) {
    mostrarToast(err.message || 'Senha incorreta.', 'error');
    document.getElementById('senhaAdmin').value = '';
  }
}

function logout() {
  sessionStorage.removeItem('tokenAdmin');
  verificarSessao();
  mostrarToast('Sessão encerrada.', 'info');
}

function verificarSessao() {
  isAdmin = !!tokenAdmin();
  document.getElementById('panelHistorico').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('adminSlotGuest').style.display = isAdmin ? 'none' : 'flex';
  document.getElementById('adminSlotUser').style.display = isAdmin ? 'flex' : 'none';
  if (isAdmin) carregarRegistros();
}

// ==========================================
// UTILITÁRIOS
// ==========================================
function formatarDataISO(isoString) {
  const d = new Date(isoString);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const seg = String(d.getSeconds()).padStart(2, '0');
  return `${dia}/${mes}/${ano} às ${hora}:${min}:${seg}`;
}

function limparFormulario() {
  document.querySelectorAll('.tipo-btn,.periodo-btn,.aula-btn').forEach(b => b.classList.remove('selected'));
  aulasSelecionadas.clear();
  ['tipoEquipamento', 'quantidade', 'responsavel', 'periodo', 'aula'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('hintDisp').textContent = '';
  document.getElementById('quantidade').removeAttribute('max');
}

const TOAST_ICONS = {
  success: 'icon-check',
  error: 'icon-alert',
  info: 'icon-info'
};

function mostrarToast(msg, tipo = 'info') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  const iconId = TOAST_ICONS[tipo] || TOAST_ICONS.info;
  t.innerHTML = `
    <span class="toast-icon"><svg class="icon"><use href="#${iconId}"/></svg></span>
    <span class="toast-msg"></span>
  `;
  t.querySelector('.toast-msg').textContent = msg; // textContent: sem risco de injetar HTML
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ==========================================
// TEMA (DARK/LIGHT MODE)
// ==========================================
function aplicarTema() {
  const tema = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', tema);
  atualizarIconeTema(tema);
}

function toggleTheme() {
  const atual = document.documentElement.getAttribute('data-theme');
  const novo = atual === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', novo);
  localStorage.setItem('theme', novo);
  atualizarIconeTema(novo);
}

function atualizarIconeTema(tema) {
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.title = tema === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro';
  }
}
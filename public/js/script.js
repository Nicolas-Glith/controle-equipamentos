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

let filtroAtual = 'todos';
let termoBusca = '';
let isAdmin = false;

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  inicializarEventos();
  verificarSessao();
  carregarInventario();
  carregarRetiradasAtivas();
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
  inputResp.addEventListener('input', function() {
    this.value = this.value.replace(/[0-9]/g, '');
  });
  inputResp.addEventListener('keypress', function(e) {
    if (/[0-9]/.test(e.key)) {
      e.preventDefault();
      mostrarToast('Números não são permitidos no nome!', 'error');
    }
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

  // Enter
  document.getElementById('senhaAdmin')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') tentarLogin();
  });

  // 🎧 Ouvinte para Devolução Rápida (Seguro contra apóstrofos e aspas)
  const listaAtivos = document.getElementById('listaAtivos');
  if (listaAtivos) {
    listaAtivos.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-devolver-tudo');
      if (btn) {
        const tipo = btn.dataset.tipo;
        const qtd = btn.dataset.qtd;
        const resp = btn.dataset.resp;
        devolucaoRapida(tipo, qtd, resp);
      }
    });
  }
}

// ==========================================
// CHAMADAS À API (SEM QUEBRAS DE LINHA)
// ==========================================
async function apiGet(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

async function apiDelete(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ==========================================
// INVENTÁRIO
// ==========================================
async function carregarInventario() {
  try {
    const dados = await apiGet('/api/inventario');
    dados.forEach(item => {
      const idMap = { 1: 'dispChromebook', 2: 'dispPositivo', 3: 'dispTablet' };
      const el = document.getElementById(idMap[item.tipo_codigo]);
      if (el) el.textContent = item.disponivel;
    });
  } catch (err) {
    console.error('Erro ao carregar inventário:', err);
  }
}

function atualizarHintDisponivel(tipo) {
  const idMap = { '1': 'dispChromebook', '2': 'dispPositivo', '3': 'dispTablet' };
  const dispEl = document.getElementById(idMap[tipo]);
  const totalMap = { '1': 22, '2': 34, '3': 40 };
  if (dispEl) {
    const disp = parseInt(dispEl.textContent) || 0;
    document.getElementById('hintDisp').textContent = `Disponível: ${disp} de ${totalMap[tipo]} ${TIPOS_EQUIPAMENTO[tipo]}`;
    document.getElementById('quantidade').max = disp;
  }
}

// ==========================================
// SELEÇÕES
// ==========================================
function selecionarTipo(btn) {
  document.querySelectorAll('.tipo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('tipoEquipamento').value = btn.dataset.tipo;
  atualizarHintDisponivel(btn.dataset.tipo);
}

function selecionarPeriodo(btn) {
  document.querySelectorAll('.periodo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('periodo').value = btn.dataset.periodo;
}

function selecionarAula(btn) {
  document.querySelectorAll('.aula-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('aula').value = btn.dataset.aula;
}

// ==========================================
// REGISTRAR RETIRADA / DEVOLUÇÃO
// ==========================================
async function atualizarTelaCompleta() {
  try {
    await carregarInventario();
    await carregarRetiradasAtivas();
    if (isAdmin) await carregarRegistros();
  } catch (err) {
    console.error('Erro ao atualizar tela:', err);
  }
}

async function registrarRetirada() {
  const tipo = document.getElementById('tipoEquipamento').value;
  const quantidade = parseInt(document.getElementById('quantidade').value);
  const responsavel = document.getElementById('responsavel').value.trim();
  const periodo = document.getElementById('periodo').value;
  const aula = document.getElementById('aula').value;

  if (!tipo || !quantidade || !responsavel || !periodo || !aula) {
    return mostrarToast('Preencha todos os campos!', 'error');
  }
  if (/[0-9]/.test(responsavel) || responsavel.length < 3) {
    return mostrarToast('Nome inválido! Apenas letras, mínimo 3 caracteres.', 'error');
  }

  try {
    await apiPost('/api/registros', {
      tipo_equipamento: parseInt(tipo),
      tipo_registro: 'retirada',
      quantidade,
      responsavel,
      periodo: PERIODOS[periodo],
      aula: AULAS[aula]
    });
    limparFormulario();
    mostrarToast(`Retirada registrada: ${quantidade}x ${TIPOS_EQUIPAMENTO[tipo]}`, 'success');
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function registrarDevolucao() {
  const tipo = document.getElementById('tipoEquipamento').value;
  const quantidade = parseInt(document.getElementById('quantidade').value);
  const responsavel = document.getElementById('responsavel').value.trim();

  if (!tipo || !quantidade || !responsavel) {
    return mostrarToast('Preencha todos os campos!', 'error');
  }
  if (/[0-9]/.test(responsavel)) {
    return mostrarToast('Nome inválido!', 'error');
  }

  try {
    await apiPost('/api/registros', {
      tipo_equipamento: parseInt(tipo),
      tipo_registro: 'devolucao',
      quantidade,
      responsavel,
      periodo: 'Devolução',
      aula: 'N/A'
    });
    limparFormulario();
    mostrarToast(`Devolução registrada: ${quantidade}x ${TIPOS_EQUIPAMENTO[tipo]}`, 'success');
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function devolucaoRapida(tipo, quantidade, responsavel) {
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
  }
}

async function carregarRetiradasAtivas() {
  const container = document.getElementById('listaAtivos');
  try {
    const timestamp = new Date().getTime();
    const ativos = await apiGet(`/api/registros/ativos?_=${timestamp}`);
    
    if (!ativos || ativos.length === 0) {
       container.innerHTML = '<div class="empty-state">✅ Nenhuma retirada ativa no momento.</div>';
       return;
    }
    
    container.innerHTML = ativos.map(item => `
      <div class="registro-item retirada">
        <div class="registro-header">
          <span class="registro-tipo retirada">⚠️ Em Uso (${item.quantidade})</span>
          <span class="registro-data">📅 ${formatarDataISO(item.data_hora)}</span>
        </div>
        <div class="registro-info">
          <span><strong>Equip:</strong> ${item.tipo_nome}</span>
          <span><strong>Resp:</strong> ${item.responsavel}</span>
          <span><strong>Período:</strong> ${item.periodo}</span>
          <span><strong>Aula:</strong> ${item.aula}</span>
        </div>
        <button class="btn btn-devolucao btn-devolver-tudo" 
                style="margin-top:8px;min-width:auto;flex:none;padding:6px 14px;font-size:0.8rem;"
                data-tipo="${item.tipo_equipamento}" 
                data-qtd="${item.quantidade}" 
                data-resp="${item.responsavel.replace(/"/g, '&quot;')}">
          📥 Devolver Tudo
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Erro ativos:', err);
    container.innerHTML = '<div class="empty-state">❌ Erro ao carregar retiradas.</div>';
  }
}

// ==========================================
// HISTÓRICO (Admin)
// ==========================================
async function carregarRegistros() {
  if (!isAdmin) return;
  try {
    const params = new URLSearchParams();
    if (filtroAtual !== 'todos') params.set('filtro', filtroAtual);
    if (termoBusca) params.set('busca', termoBusca);
    const registros = await apiGet(`/api/registros?${params.toString()}`);
    
    const container = document.getElementById('listaHistorico');
    if (registros.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhum registro encontrado.</div>';
      return;
    }
    
    container.innerHTML = registros.map(item => `
      <div class="registro-item ${item.tipo_registro}">
        <div class="registro-header">
          <span class="registro-tipo ${item.tipo_registro}">
            ${item.tipo_registro === 'retirada' ? '📤 Retirada' : '📥 Devolução'}
          </span>
          <span class="registro-data">📅 ${formatarDataISO(item.data_hora)}</span>
        </div>
        <div class="registro-info">
          <span><strong>Equip:</strong> ${item.tipo_nome}</span>
          <span><strong>Qtd:</strong> ${item.quantidade}</span>
          <span><strong>Resp:</strong> ${item.responsavel}</span>
          <span><strong>Período:</strong> ${item.periodo}</span>
          <span><strong>Aula:</strong> ${item.aula}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
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
  if (!confirm('⚠️ Limpar TODO o histórico? Irreversível!')) return;
  try {
    await apiDelete('/api/registros');
    carregarRegistros();
    carregarRetiradasAtivas();
    carregarInventario();
    mostrarToast('Histórico limpo!', 'info');
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
  header.innerHTML = `<h1>E.E. "Luiz Bianconi"</h1> <p><strong>Relatório de Controle de Equipamentos</strong></p> <p>Gerado em: ${new Date().toLocaleString('pt-BR')}</p>`;
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
    await apiPost('/api/login', { senha });
    sessionStorage.setItem('sessaoAdmin', 'true');
    fecharModalLogin();
    verificarSessao();
    mostrarToast('Bem-vindo, Administrador!', 'success');
  } catch {
    mostrarToast('Senha incorreta!', 'error');
    document.getElementById('senhaAdmin').value = '';
  }
}

function logout() {
  sessionStorage.removeItem('sessaoAdmin');
  verificarSessao();
  mostrarToast('Sessão encerrada.', 'info');
}

function verificarSessao() {
  isAdmin = sessionStorage.getItem('sessaoAdmin') === 'true';
  document.getElementById('panelHistorico').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('panelLoginAdmin').style.display = isAdmin ? 'none' : 'block';
  document.getElementById('adminBar').style.display = isAdmin ? 'flex' : 'none';
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
  ['tipoEquipamento','quantidade','responsavel','periodo','aula'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('hintDisp').textContent = '';
}

function mostrarToast(msg, tipo = 'info') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
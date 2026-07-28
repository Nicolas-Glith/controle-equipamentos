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

// Intervalo de atualização automática (ms)
const INTERVALO_ATUALIZACAO = 25000;

let filtroAtual = 'todos';
let termoBusca = '';
let isAdmin = false;
let aulasSelecionadas = new Set();

// Correção do bug de inventário hardcoded:
// os totais agora vêm da própria API e ficam guardados aqui,
// em vez de um objeto fixo no código.
let inventarioTotais = {}; // ex: { '1': 22, '2': 36, '3': 44 }

// Paginação do histórico
let paginaAtual = 1;
const ITENS_POR_PAGINA = 20;

// Registro em edição (histórico admin)
let registroEditandoId = null;
let aulasEdicaoSelecionadas = new Set();

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  aplicarTema();
  inicializarEventos();
  verificarSessao();
  carregarInventario();
  carregarRetiradasAtivas();
  iniciarAtualizacaoAutomatica();
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
        paginaAtual = 1;
        carregarRegistros();
      }, 300);
    });
  }

  // Enter no login
  document.getElementById('senhaAdmin')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') tentarLogin();
  });

  // Enter no modal de edição
  document.getElementById('modalEditar')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') salvarEdicao();
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

  // 🎧 Ouvinte para botão Editar no histórico
  const listaHistorico = document.getElementById('listaHistorico');
  if (listaHistorico) {
    listaHistorico.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-editar-registro');
      if (btn) {
        abrirModalEditar(btn.dataset.id);
      }
    });
  }

  // 🎧 Ouvinte para botões de paginação
  const paginacao = document.getElementById('paginacaoHistorico');
  if (paginacao) {
    paginacao.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pagina]');
      if (btn && !btn.disabled) {
        paginaAtual = parseInt(btn.dataset.pagina);
        carregarRegistros();
      }
    });
  }

  // Seletores dentro do modal de edição
  document.querySelectorAll('#modalEditar .tipo-btn-edit').forEach(btn => {
    btn.addEventListener('click', () => selecionarTipoEdicao(btn));
  });
  document.querySelectorAll('#modalEditar .periodo-btn-edit').forEach(btn => {
    btn.addEventListener('click', () => selecionarPeriodoEdicao(btn));
  });
  document.querySelectorAll('#modalEditar .aula-btn-edit').forEach(btn => {
    btn.addEventListener('click', () => selecionarAulaEdicao(btn));
  });
}

// ==========================================
// ATUALIZAÇÃO AUTOMÁTICA (novo)
// Mantém o painel sincronizado entre professores
// diferentes usando o sistema ao mesmo tempo, sem
// precisar dar F5 manualmente.
// ==========================================
function iniciarAtualizacaoAutomatica() {
  setInterval(async () => {
    // Evita interromper o usuário se um modal estiver aberto
    const modalLoginAberto = document.getElementById('modalLogin')?.style.display === 'flex';
    const modalEditarAberto = document.getElementById('modalEditar')?.style.display === 'flex';
    if (modalLoginAberto || modalEditarAberto) return;

    try {
      await carregarInventario();
      await carregarRetiradasAtivas();
      if (isAdmin) await carregarRegistros();
    } catch (err) {
      console.error('Erro na atualização automática:', err);
    }
  }, INTERVALO_ATUALIZACAO);
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

async function apiPut(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
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

      // Guarda o total real vindo do banco (corrige o bug do
      // total hardcoded que ficava desatualizado após migrações)
      inventarioTotais[item.tipo_codigo] = parseInt(item.quantidade_total);

      // Atualiza também o número "total" exibido no card, caso
      // tenha mudado desde o último carregamento
      const totalIdMap = { 1: '.chromebook .inv-total', 2: '.positivo .inv-total', 3: '.tablet .inv-total' };
      const totalEl = document.querySelector(totalIdMap[item.tipo_codigo]);
      if (totalEl) totalEl.textContent = item.quantidade_total;
    });

    // Se o tipo selecionado no formulário estiver com o hint aberto,
    // atualiza o hint com o total já correto.
    const tipoSelecionado = document.getElementById('tipoEquipamento').value;
    if (tipoSelecionado) atualizarHintDisponivel(tipoSelecionado);
  } catch (err) {
    console.error('Erro ao carregar inventário:', err);
  }
}

function atualizarHintDisponivel(tipo) {
  const idMap = { '1': 'dispChromebook', '2': 'dispPositivo', '3': 'dispTablet' };
  const dispEl = document.getElementById(idMap[tipo]);
  // Usa o total real vindo da API (inventarioTotais), não mais um valor fixo
  const total = inventarioTotais[tipo] ?? inventarioTotais[parseInt(tipo)] ?? '?';
  if (dispEl) {
    const disp = parseInt(dispEl.textContent) || 0;
    document.getElementById('hintDisp').textContent = `Disponível: ${disp} de ${total} ${TIPOS_EQUIPAMENTO[tipo]}`;
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
  const aula = btn.dataset.aula;
  if (aulasSelecionadas.has(aula)) {
    aulasSelecionadas.delete(aula);
    btn.classList.remove('selected');
  } else {
    aulasSelecionadas.add(aula);
    btn.classList.add('selected');
  }
  document.getElementById('aula').value = Array.from(aulasSelecionadas).join(',');
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
  const aulas = Array.from(aulasSelecionadas).map(a => AULAS[a]).join(', ');

  if (!tipo || !quantidade || !responsavel || !periodo || aulasSelecionadas.size === 0) {
    return mostrarToast('Preencha todos os campos e selecione pelo menos uma aula!', 'error');
  }
  if (/[0-9]/.test(responsavel) || responsavel.length < 3) {
    return mostrarToast('Nome inválido! Apenas letras, mínimo 3 caracteres.', 'error');
  }

  const btn = document.querySelector('.btn-retirada');
  desabilitarBotao(btn, true);

  try {
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
  } finally {
    desabilitarBotao(btn, false);
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

  const btn = document.querySelector('.btn-devolucao');
  desabilitarBotao(btn, true);

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
  } finally {
    desabilitarBotao(btn, false);
  }
}

// Evita duplo-clique / clique nervoso gerando registros duplicados
function desabilitarBotao(btn, desabilitado) {
  if (!btn) return;
  btn.disabled = desabilitado;
  btn.style.opacity = desabilitado ? '0.6' : '1';
  btn.style.cursor = desabilitado ? 'not-allowed' : 'pointer';
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
// HISTÓRICO (Admin) — agora paginado
// ==========================================
async function carregarRegistros() {
  if (!isAdmin) return;
  try {
    const params = new URLSearchParams();
    if (filtroAtual !== 'todos') params.set('filtro', filtroAtual);
    if (termoBusca) params.set('busca', termoBusca);
    params.set('page', paginaAtual);
    params.set('limit', ITENS_POR_PAGINA);

    const resposta = await apiGet(`/api/registros?${params.toString()}`);
    const registros = resposta.data;

    const container = document.getElementById('listaHistorico');
    if (registros.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhum registro encontrado.</div>';
      renderizarPaginacao(1, 1);
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
        <button class="btn-editar-registro" data-id="${item.id}" title="Editar registro">
          ✏️ Editar
        </button>
      </div>
    `).join('');

    renderizarPaginacao(resposta.page, resposta.totalPages);
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
  }
}

function renderizarPaginacao(paginaAtualResp, totalPaginas) {
  const container = document.getElementById('paginacaoHistorico');
  if (!container) return;

  if (totalPaginas <= 1) {
    container.innerHTML = '';
    return;
  }

  let botoes = '';
  botoes += `<button data-pagina="${paginaAtualResp - 1}" ${paginaAtualResp <= 1 ? 'disabled' : ''}>◀ Anterior</button>`;
  botoes += `<span class="pagina-info">Página ${paginaAtualResp} de ${totalPaginas}</span>`;
  botoes += `<button data-pagina="${paginaAtualResp + 1}" ${paginaAtualResp >= totalPaginas ? 'disabled' : ''}>Próxima ▶</button>`;

  container.innerHTML = botoes;
}

function filtrarHistorico(btn) {
  document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filtroAtual = btn.dataset.filtro;
  paginaAtual = 1;
  carregarRegistros();
}

function limparBusca() {
  document.getElementById('buscaHistorico').value = '';
  termoBusca = '';
  paginaAtual = 1;
  carregarRegistros();
}

async function limparHistorico() {
  if (!confirm('⚠️ Limpar TODO o histórico? Irreversível!')) return;
  try {
    await apiDelete('/api/registros');
    paginaAtual = 1;
    carregarRegistros();
    carregarRetiradasAtivas();
    carregarInventario();
    mostrarToast('Histórico limpo!', 'info');
  } catch (err) {
    mostrarToast('Erro ao limpar: ' + err.message, 'error');
  }
}

// ==========================================
// EDIÇÃO DE REGISTRO (novo)
// ==========================================
function abrirModalEditar(id) {
  // Busca o registro atual na lista já carregada na tela
  const item = document.querySelector(`.btn-editar-registro[data-id="${id}"]`)?.closest('.registro-item');
  if (!item) return;

  registroEditandoId = id;

  // Preenche os dados a partir do texto exibido (mais simples e evita nova chamada à API)
  const tipoTexto = item.querySelector('.registro-info span:nth-child(1)').textContent.replace('Equip:', '').trim();
  const qtdTexto = item.querySelector('.registro-info span:nth-child(2)').textContent.replace('Qtd:', '').trim();
  const respTexto = item.querySelector('.registro-info span:nth-child(3)').textContent.replace('Resp:', '').trim();
  const periodoTexto = item.querySelector('.registro-info span:nth-child(4)').textContent.replace('Período:', '').trim();
  const aulaTexto = item.querySelector('.registro-info span:nth-child(5)').textContent.replace('Aula:', '').trim();
  const tipoRegistro = item.classList.contains('retirada') ? 'retirada' : 'devolucao';

  const tipoCodigo = Object.keys(TIPOS_EQUIPAMENTO).find(k => TIPOS_EQUIPAMENTO[k] === tipoTexto);

  document.getElementById('editQuantidade').value = qtdTexto;
  document.getElementById('editResponsavel').value = respTexto;
  document.getElementById('editTipoRegistro').value = tipoRegistro;
  document.getElementById('editTipoEquipamento').value = tipoCodigo || '';
  document.getElementById('editPeriodo').value = periodoTexto;
  document.getElementById('editAulaTexto').value = aulaTexto;

  document.querySelectorAll('#modalEditar .tipo-btn-edit').forEach(b => {
    b.classList.toggle('selected', b.dataset.tipo === tipoCodigo);
  });

  document.getElementById('modalEditar').style.display = 'flex';
}

function selecionarTipoEdicao(btn) {
  document.querySelectorAll('#modalEditar .tipo-btn-edit').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('editTipoEquipamento').value = btn.dataset.tipo;
}

function selecionarPeriodoEdicao(btn) {
  document.querySelectorAll('#modalEditar .periodo-btn-edit').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('editPeriodo').value = PERIODOS[btn.dataset.periodo];
}

function selecionarAulaEdicao(btn) {
  const aula = btn.dataset.aula;
  if (aulasEdicaoSelecionadas.has(aula)) {
    aulasEdicaoSelecionadas.delete(aula);
    btn.classList.remove('selected');
  } else {
    aulasEdicaoSelecionadas.add(aula);
    btn.classList.add('selected');
  }
  const aulasTexto = Array.from(aulasEdicaoSelecionadas).map(a => AULAS[a]).join(', ');
  if (aulasTexto) document.getElementById('editAulaTexto').value = aulasTexto;
}

function fecharModalEditar() {
  document.getElementById('modalEditar').style.display = 'none';
  registroEditandoId = null;
  aulasEdicaoSelecionadas.clear();
  document.querySelectorAll('#modalEditar .tipo-btn-edit, #modalEditar .periodo-btn-edit, #modalEditar .aula-btn-edit')
    .forEach(b => b.classList.remove('selected'));
}

async function salvarEdicao() {
  if (!registroEditandoId) return;

  const tipo = document.getElementById('editTipoEquipamento').value;
  const tipoRegistro = document.getElementById('editTipoRegistro').value;
  const quantidade = parseInt(document.getElementById('editQuantidade').value);
  const responsavel = document.getElementById('editResponsavel').value.trim();
  const periodo = document.getElementById('editPeriodo').value;
  const aula = document.getElementById('editAulaTexto').value.trim();

  if (!tipo || !quantidade || !responsavel || !periodo || !aula) {
    return mostrarToast('Preencha todos os campos!', 'error');
  }
  if (/[0-9]/.test(responsavel)) {
    return mostrarToast('Nome inválido! Não pode conter números.', 'error');
  }

  try {
    await apiPut(`/api/registros/${registroEditandoId}`, {
      tipo_equipamento: parseInt(tipo),
      tipo_registro: tipoRegistro,
      quantidade,
      responsavel,
      periodo,
      aula
    });
    mostrarToast('Registro atualizado com sucesso!', 'success');
    fecharModalEditar();
    await atualizarTelaCompleta();
  } catch (err) {
    mostrarToast(err.message, 'error');
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
  if (isAdmin) {
    paginaAtual = 1;
    carregarRegistros();
  }
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
    btn.textContent = tema === 'dark' ? '🌙' : '☀️';
    btn.title = tema === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro';
  }
}
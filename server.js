require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
// Nunca deixar o navegador/CDN guardar respostas da API em cache
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONEXÃO POSTGRESQL (HÍBRIDA: LOCAL OU VERCEL)
// ==========================================
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 1 // serverless: 1 conexão por instância (use a URL do pooler do Supabase, porta 6543)
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      }
);

// ==========================================
// AUTENTICAÇÃO ADMIN (token assinado, sem estado)
// ==========================================
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.ADMIN_SENHA || 'dev-secret';

function assinar(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function tokenValido(token) {
  if (!token) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const esperado = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

function exigirAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (tokenValido(token)) return next();
  res.status(401).json({ error: 'Não autorizado. Faça login como administrador.' });
}

// ==========================================
// REGRAS DE ESTOQUE (usadas em POST e PUT)
// ==========================================
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');

// +quantidade na retirada, -quantidade na devolução
const SINAL = `CASE WHEN tipo_registro = 'retirada' THEN quantidade ELSE -quantidade END`;

/**
 * Valida uma movimentação dentro de uma transação.
 * - Retirada: não pode passar do total disponível do equipamento.
 * - Devolução: não pode passar do que ESTE professor tem em uso.
 * ignorarId: usado na edição, para não contar o próprio registro.
 */
async function validarMovimentacao(client, { tipo_equipamento, tipo_registro, quantidade, responsavel }, ignorarId = null) {
  // Trava a linha do inventário: serializa operações simultâneas do mesmo equipamento
  const inv = await client.query(
    'SELECT nome, quantidade_total FROM inventario WHERE tipo_codigo = $1 FOR UPDATE',
    [tipo_equipamento]
  );
  if (inv.rows.length === 0) throw new Error('Tipo de equipamento inválido.');

  const total = parseInt(inv.rows[0].quantidade_total);
  const nome = inv.rows[0].nome;

  if (tipo_registro === 'retirada') {
    const uso = await client.query(
      `SELECT COALESCE(SUM(${SINAL}), 0) AS v
       FROM registros
       WHERE tipo_equipamento = $1 AND ($2::int IS NULL OR id <> $2::int)`,
      [tipo_equipamento, ignorarId]
    );
    const emUso = parseInt(uso.rows[0].v);
    const disponivel = total - emUso;
    if (quantidade > disponivel) {
      throw new Error(`Estoque insuficiente! Disponível: ${Math.max(0, disponivel)} de ${total} ${nome}(s)`);
    }
  } else {
    const saldo = await client.query(
      `SELECT COALESCE(SUM(${SINAL}), 0) AS v
       FROM registros
       WHERE tipo_equipamento = $1
         AND LOWER(TRIM(responsavel)) = LOWER(TRIM($2))
         AND ($3::int IS NULL OR id <> $3::int)`,
      [tipo_equipamento, responsavel, ignorarId]
    );
    const saldoResp = parseInt(saldo.rows[0].v);
    if (quantidade > saldoResp) {
      throw new Error(
        saldoResp <= 0
          ? `${responsavel} não tem ${nome}(s) em uso para devolver.`
          : `${responsavel} tem apenas ${saldoResp} ${nome}(s) em uso para devolver.`
      );
    }
  }
}

/**
 * Checagem final (usada na edição): depois de alterar um registro,
 * garante que nenhum saldo ficou negativo nem acima do total.
 */
async function verificarInvariantes(client, tipos) {
  for (const tipo of tipos) {
    const inv = await client.query(
      'SELECT nome, quantidade_total FROM inventario WHERE tipo_codigo = $1',
      [tipo]
    );
    if (inv.rows.length === 0) continue;
    const { nome, quantidade_total } = inv.rows[0];

    const tot = await client.query(
      `SELECT COALESCE(SUM(${SINAL}), 0) AS v FROM registros WHERE tipo_equipamento = $1`,
      [tipo]
    );
    const emUso = parseInt(tot.rows[0].v);
    if (emUso > quantidade_total || emUso < 0) {
      throw new Error(`Edição inválida: deixaria o estoque de ${nome} inconsistente.`);
    }

    const neg = await client.query(
      `SELECT LOWER(TRIM(responsavel)) AS r
       FROM registros WHERE tipo_equipamento = $1
       GROUP BY LOWER(TRIM(responsavel))
       HAVING SUM(${SINAL}) < 0`,
      [tipo]
    );
    if (neg.rows.length > 0) {
      throw new Error(`Edição inválida: "${neg.rows[0].r}" ficaria com mais devoluções do que retiradas.`);
    }
  }
}

function validarCorpo(body) {
  const tipo_equipamento = parseInt(body.tipo_equipamento);
  const quantidade = parseInt(body.quantidade);
  const responsavel = norm(body.responsavel);
  const { tipo_registro, periodo, aula } = body;

  if (!tipo_equipamento || !quantidade || !responsavel || !periodo || !aula) {
    return { erro: 'Todos os campos são obrigatórios.' };
  }
  if (!Number.isInteger(quantidade) || quantidade <= 0) {
    return { erro: 'Quantidade deve ser um número maior que zero.' };
  }
  if (!['retirada', 'devolucao'].includes(tipo_registro)) {
    return { erro: 'Tipo de registro inválido.' };
  }
  if (/[0-9]/.test(responsavel)) {
    return { erro: 'O nome do responsável não pode conter números.' };
  }
  return { dados: { tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula } };
}

// ==========================================
// REGISTRAR RETIRADA / DEVOLUÇÃO
// ==========================================
app.post('/api/registros', async (req, res) => {
  const { erro, dados } = validarCorpo(req.body || {});
  if (erro) return res.status(400).json({ error: erro });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await validarMovimentacao(client, dados);

    const ins = await client.query(
      `INSERT INTO registros (tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [dados.tipo_equipamento, dados.tipo_registro, dados.quantidade, dados.responsavel, dados.periodo, dados.aula]
    );

    await client.query('COMMIT');
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// ==========================================
// EDIÇÃO DE REGISTRO (admin)
// ==========================================
app.put('/api/registros/:id', exigirAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido.' });

  const { erro, dados } = validarCorpo(req.body || {});
  if (erro) return res.status(400).json({ error: erro });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const old = await client.query('SELECT * FROM registros WHERE id = $1 FOR UPDATE', [id]);
    if (old.rows.length === 0) throw new Error('Registro não encontrado.');

    // Trava os dois tipos (antigo e novo) sempre na mesma ordem, evitando deadlock
    const tipos = [...new Set([old.rows[0].tipo_equipamento, dados.tipo_equipamento])].sort((a, b) => a - b);
    await client.query(
      'SELECT 1 FROM inventario WHERE tipo_codigo = ANY($1::int[]) ORDER BY tipo_codigo FOR UPDATE',
      [tipos]
    );

    await validarMovimentacao(client, dados, id);

    const upd = await client.query(
      `UPDATE registros
       SET tipo_equipamento = $1, tipo_registro = $2, quantidade = $3,
           responsavel = $4, periodo = $5, aula = $6
       WHERE id = $7 RETURNING *`,
      [dados.tipo_equipamento, dados.tipo_registro, dados.quantidade, dados.responsavel, dados.periodo, dados.aula, id]
    );

    await verificarInvariantes(client, tipos);

    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// ==========================================
// LISTAGEM DE REGISTROS COM PAGINAÇÃO (admin)
// ==========================================
app.get('/api/registros', exigirAdmin, async (req, res) => {
  const { filtro, busca } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  let whereClause = ' WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (filtro === 'retirada') {
    whereClause += " AND r.tipo_registro = 'retirada'";
  } else if (filtro === 'devolucao') {
    whereClause += " AND r.tipo_registro = 'devolucao'";
  } else if (filtro === 'hoje') {
    whereClause += ' AND DATE(r.data_hora) = CURRENT_DATE';
  }

  if (busca) {
    whereClause += ` AND ( LOWER(r.responsavel) LIKE LOWER($${paramIndex}) OR LOWER(i.nome) LIKE LOWER($${paramIndex}) OR LOWER(r.periodo) LIKE LOWER($${paramIndex}) OR TO_CHAR(r.data_hora, 'DD/MM/YYYY') LIKE $${paramIndex} )`;
    params.push(`%${busca}%`);
    paramIndex++;
  }

  const dataQuery = `SELECT r.*, i.nome AS tipo_nome FROM registros r JOIN inventario i ON r.tipo_equipamento = i.tipo_codigo${whereClause} ORDER BY r.data_hora DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  const countQuery = `SELECT COUNT(*) FROM registros r JOIN inventario i ON r.tipo_equipamento = i.tipo_codigo${whereClause}`;

  try {
    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [...params, limit, offset]),
      pool.query(countQuery, params)
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({
      data: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// INVENTÁRIO — calculado direto de registros
// (mesma regra da validação; não depende da view vw_disponiveis)
// ==========================================
app.get('/api/inventario', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.tipo_codigo,
             i.nome,
             i.quantidade_total,
             (i.quantidade_total - COALESCE(SUM(${SINAL}), 0))::int AS disponivel
      FROM inventario i
      LEFT JOIN registros ON registros.tipo_equipamento = i.tipo_codigo
      GROUP BY i.tipo_codigo, i.nome, i.quantidade_total
      ORDER BY i.tipo_codigo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro inventario:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Retiradas ativas agrupadas por equipamento + responsável
// (ignora diferença de maiúsculas/espaços no nome)
// ==========================================
app.get('/api/registros/ativos', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH saldo AS (
        SELECT tipo_equipamento,
               LOWER(TRIM(responsavel)) AS chave,
               SUM(${SINAL}) AS pendente
        FROM registros
        GROUP BY tipo_equipamento, LOWER(TRIM(responsavel))
      )
      SELECT s.tipo_equipamento,
             i.nome AS tipo_nome,
             s.pendente::int AS quantidade,
             r.responsavel, r.periodo, r.aula, r.data_hora
      FROM saldo s
      JOIN inventario i ON s.tipo_equipamento = i.tipo_codigo
      JOIN LATERAL (
        SELECT responsavel, periodo, aula, data_hora
        FROM registros
        WHERE tipo_equipamento = s.tipo_equipamento
          AND LOWER(TRIM(responsavel)) = s.chave
          AND tipo_registro = 'retirada'
        ORDER BY data_hora DESC
        LIMIT 1
      ) r ON true
      WHERE s.pendente > 0
      ORDER BY r.data_hora DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ativos:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/registros', exigirAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM registros');
    res.json({ message: 'Histórico limpo com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// LOGIN ADMIN
// ==========================================
app.post('/api/login', (req, res) => {
  const { senha } = req.body || {};
  if (!process.env.ADMIN_SENHA) {
    return res.status(500).json({ error: 'ADMIN_SENHA não configurada no servidor.' });
  }
  if (senha && senha === process.env.ADMIN_SENHA) {
    const token = assinar({ exp: Date.now() + 8 * 60 * 60 * 1000 }); // 8 horas
    return res.json({ success: true, token });
  }
  res.status(401).json({ error: 'Senha incorreta.' });
});

// Diagnóstico rápido: abra /api/health para ver se a API alcança o banco
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// EXPORTAÇÃO PARA VERCEL E INICIALIZAÇÃO LOCAL
// ==========================================
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📦 Conectado ao PostgreSQL: ${process.env.DB_NAME || 'Supabase'}`);
  });
}
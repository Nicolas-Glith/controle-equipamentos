require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONEXÃO POSTGRESQL (HÍBRIDA: LOCAL OU VERCEL)
// ==========================================
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        // Se estiver na Vercel/Supabase (Nuvem)
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        // Se estiver no seu PC (Local)
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      }
);

// ==========================================
// ROTAS DE INVENTÁRIO E REGISTROS
// ==========================================
app.post('/api/registros', async (req, res) => {
  const { tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula } = req.body;

  if (!tipo_equipamento || !quantidade || !responsavel || !periodo || !aula) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }
  if (/[0-9]/.test(responsavel)) {
    return res.status(400).json({ error: 'O nome do responsável não pode conter números.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invResult = await client.query(
      'SELECT tipo_codigo, nome, quantidade_total FROM inventario WHERE tipo_codigo = $1 FOR UPDATE',
      [tipo_equipamento]
    );
    if (invResult.rows.length === 0) {
      throw new Error('Tipo de equipamento inválido.');
    }

    const total = parseInt(invResult.rows[0].quantidade_total);
    const usoResult = await client.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN tipo_registro = 'retirada' THEN quantidade ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN tipo_registro = 'devolucao' THEN quantidade ELSE 0 END), 0) AS em_uso
       FROM registros 
       WHERE tipo_equipamento = $1`,
      [tipo_equipamento]
    );
    const emUso = parseInt(usoResult.rows[0].em_uso);
    const disponivel = total - emUso;

    if (tipo_registro === 'retirada' && quantidade > disponivel) {
      throw new Error(`Estoque insuficiente! Disponível: ${disponivel} de ${total} ${invResult.rows[0].nome}(s)`);
    }
    if (tipo_registro === 'devolucao' && quantidade > emUso) {
      throw new Error(`Não há ${quantidade} equipamento(s) em uso para devolver. Em uso: ${emUso}`);
    }

    const insertResult = await client.query(
      `INSERT INTO registros (tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula]
    );
    await client.query('COMMIT');
    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// EDIÇÃO DE REGISTRO (novo)
// Permite corrigir um registro com erro de digitação
// revalidando o estoque disponível, excluindo o próprio
// registro do cálculo de "em uso" antes de aplicar as
// novas condições.
// ==========================================
app.put('/api/registros/:id', async (req, res) => {
  const { id } = req.params;
  const { tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula } = req.body;

  if (!tipo_equipamento || !quantidade || !responsavel || !periodo || !aula) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }
  if (/[0-9]/.test(responsavel)) {
    return res.status(400).json({ error: 'O nome do responsável não pode conter números.' });
  }
  if (parseInt(quantidade) <= 0) {
    return res.status(400).json({ error: 'Quantidade deve ser maior que zero.' });
  }
  if (!['retirada', 'devolucao'].includes(tipo_registro)) {
    return res.status(400).json({ error: 'Tipo de registro inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const oldResult = await client.query('SELECT * FROM registros WHERE id = $1 FOR UPDATE', [id]);
    if (oldResult.rows.length === 0) {
      throw new Error('Registro não encontrado.');
    }

    const invResult = await client.query(
      'SELECT tipo_codigo, nome, quantidade_total FROM inventario WHERE tipo_codigo = $1 FOR UPDATE',
      [tipo_equipamento]
    );
    if (invResult.rows.length === 0) {
      throw new Error('Tipo de equipamento inválido.');
    }

    const total = parseInt(invResult.rows[0].quantidade_total);

    // Calcula o "em uso" do tipo de equipamento de destino,
    // excluindo o próprio registro que está sendo editado
    // (para não contar duas vezes o mesmo lançamento).
    const usoResult = await client.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN tipo_registro = 'retirada' THEN quantidade ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN tipo_registro = 'devolucao' THEN quantidade ELSE 0 END), 0) AS em_uso
       FROM registros 
       WHERE tipo_equipamento = $1 AND id <> $2`,
      [tipo_equipamento, id]
    );
    const emUso = parseInt(usoResult.rows[0].em_uso);
    const disponivel = total - emUso;

    if (tipo_registro === 'retirada' && quantidade > disponivel) {
      throw new Error(`Estoque insuficiente! Disponível: ${disponivel} de ${total} ${invResult.rows[0].nome}(s)`);
    }
    if (tipo_registro === 'devolucao' && quantidade > emUso) {
      throw new Error(`Não há ${quantidade} equipamento(s) em uso para devolver. Em uso: ${emUso}`);
    }

    const updated = await client.query(
      `UPDATE registros 
       SET tipo_equipamento = $1, tipo_registro = $2, quantidade = $3, 
           responsavel = $4, periodo = $5, aula = $6
       WHERE id = $7 RETURNING *`,
      [tipo_equipamento, tipo_registro, quantidade, responsavel, periodo, aula, id]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// LISTAGEM DE REGISTROS COM PAGINAÇÃO (atualizado)
// ==========================================
app.get('/api/registros', async (req, res) => {
  const { filtro, busca } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  let whereClause = ` WHERE 1=1`;
  const params = [];
  let paramIndex = 1;

  if (filtro === 'retirada') {
    whereClause += ` AND r.tipo_registro = 'retirada'`;
  } else if (filtro === 'devolucao') {
    whereClause += ` AND r.tipo_registro = 'devolucao'`;
  } else if (filtro === 'hoje') {
    whereClause += ` AND DATE(r.data_hora) = CURRENT_DATE`;
  }

  if (busca) {
    whereClause += ` AND ( LOWER(r.responsavel) LIKE LOWER($${paramIndex}) OR LOWER(i.nome) LIKE LOWER($${paramIndex}) OR LOWER(r.periodo) LIKE LOWER($${paramIndex}) OR TO_CHAR(r.data_hora, 'DD/MM/YYYY') LIKE $${paramIndex} )`;
    params.push(`%${busca}%`);
    paramIndex++;
  }

  const dataQuery = `SELECT r.*, i.nome AS tipo_nome FROM registros r JOIN inventario i ON r.tipo_equipamento = i.tipo_codigo${whereClause} ORDER BY r.data_hora DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  const countQuery = `SELECT COUNT(*) FROM registros r JOIN inventario i ON r.tipo_equipamento = i.tipo_codigo${whereClause}`;

  const dataParams = [...params, limit, offset];
  const countParams = [...params];

  try {
    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, countParams)
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

app.get('/api/inventario', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT tipo_codigo, nome, quantidade_total, disponivel FROM vw_disponiveis ORDER BY tipo_codigo'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro inventario:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Retiradas ativas agrupadas por equipamento + responsável
// (corrige mesclagem de registros de professores diferentes)
// ==========================================
app.get('/api/registros/ativos', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH saldo AS (
        SELECT tipo_equipamento, responsavel,
               SUM(CASE WHEN tipo_registro = 'retirada' THEN quantidade ELSE 0 END) -
               SUM(CASE WHEN tipo_registro = 'devolucao' THEN quantidade ELSE 0 END) AS pendente
        FROM registros
        GROUP BY tipo_equipamento, responsavel
      )
      SELECT s.tipo_equipamento, i.nome AS tipo_nome, s.pendente AS quantidade,
             s.responsavel, r.periodo, r.aula, r.data_hora
      FROM saldo s
      JOIN inventario i ON s.tipo_equipamento = i.tipo_codigo
      JOIN LATERAL (
        SELECT periodo, aula, data_hora
        FROM registros
        WHERE tipo_equipamento = s.tipo_equipamento
          AND responsavel = s.responsavel
          AND tipo_registro = 'retirada'
        ORDER BY data_hora DESC LIMIT 1
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

app.delete('/api/registros', async (req, res) => {
  try {
    await pool.query('DELETE FROM registros');
    res.json({ message: 'Histórico limpo com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === process.env.ADMIN_SENHA) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta.' });
  }
});

// ==========================================
// EXPORTAÇÃO PARA VERCEL E INICIALIZAÇÃO LOCAL
// ==========================================
// Exporta o app para a Vercel (Serverless)
module.exports = app;

// Inicia o servidor apenas em ambiente local (não na Vercel)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📦 Conectado ao PostgreSQL: ${process.env.DB_NAME || 'Supabase'}`);
  });
}
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./config/database');

const app = express();

app.use(cors());
app.use(express.json());
// Aponta para a pasta public na raiz
app.use(express.static(path.join(__dirname, '../public')));

// --- COLE AQUI SUAS ROTAS (ou importe dos controllers) ---
// Exemplo de como ficaria a rota de inventário usando o pool:
app.get('/api/inventario', async (req, res) => {
  try {
    const result = await pool.query('SELECT tipo_codigo, nome, quantidade_total, disponivel FROM vw_disponiveis ORDER BY tipo_codigo');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ... (Mova o resto das rotas do seu server.js original para cá) ...

// Servir o index.html para qualquer rota que não seja API (Single Page App behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Exporta o app para a Vercel (NÃO dê listen aqui se for rodar na Vercel)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Servidor local rodando em http://localhost:${PORT}`));
}

module.exports = app;
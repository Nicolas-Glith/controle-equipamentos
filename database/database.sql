-- Tabela de Inventário (Configuração fixa)
CREATE TABLE inventario (
    id SERIAL PRIMARY KEY,
    tipo_codigo INTEGER UNIQUE NOT NULL, -- 1=Chromebook, 2=Positivo, 3=Tablet
    nome VARCHAR(50) NOT NULL,
    quantidade_total INTEGER NOT NULL DEFAULT 0
);

-- Inserção inicial do inventário
INSERT INTO inventario (tipo_codigo, nome, quantidade_total) VALUES
(1, 'Chromebook', 22),
(2, 'Positivo', 34),
(3, 'Tablet', 40);

-- Tabela de Registros (Retiradas e Devoluções)
CREATE TABLE registros (
    id SERIAL PRIMARY KEY,
    tipo_equipamento INTEGER NOT NULL REFERENCES inventario(tipo_codigo),
    tipo_registro VARCHAR(10) NOT NULL CHECK (tipo_registro IN ('retirada', 'devolucao')),
    quantidade INTEGER NOT NULL CHECK (quantidade > 0),
    responsavel VARCHAR(200) NOT NULL,
    periodo VARCHAR(20) NOT NULL,
    aula VARCHAR(20) NOT NULL,
    data_hora TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    observacao TEXT
);

-- Índice para buscas rápidas por data e responsável
CREATE INDEX idx_registros_data ON registros(data_hora DESC);
CREATE INDEX idx_registros_responsavel ON registros(responsavel);
CREATE INDEX idx_registros_tipo ON registros(tipo_equipamento, tipo_registro);

-- View para calcular disponíveis em tempo real
CREATE VIEW vw_disponiveis AS
SELECT 
    i.tipo_codigo,
    i.nome,
    i.quantidade_total,
    COALESCE(SUM(CASE WHEN r.tipo_registro = 'retirada' THEN r.quantidade ELSE 0 END), 0) -
    COALESCE(SUM(CASE WHEN r.tipo_registro = 'devolucao' THEN r.quantidade ELSE 0 END), 0) AS em_uso,
    i.quantidade_total - (
        COALESCE(SUM(CASE WHEN r.tipo_registro = 'retirada' THEN r.quantidade ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN r.tipo_registro = 'devolucao' THEN r.quantidade ELSE 0 END), 0)
    ) AS disponivel
FROM inventario i
LEFT JOIN registros r ON i.tipo_codigo = r.tipo_equipamento
GROUP BY i.tipo_codigo, i.nome, i.quantidade_total;
-- Migração: Atualizar quantidades do inventário
-- Execute este script apenas uma vez

UPDATE inventario SET quantidade_total = 36 WHERE tipo_codigo = 2; -- Positivo
UPDATE inventario SET quantidade_total = 44 WHERE tipo_codigo = 3; -- Tablet
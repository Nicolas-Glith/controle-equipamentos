-- Migração: Aumentar tamanho do campo aula para suportar múltiplas aulas
-- Execute este script apenas uma vez no banco de dados existente

ALTER TABLE registros ALTER COLUMN aula TYPE VARCHAR(100);
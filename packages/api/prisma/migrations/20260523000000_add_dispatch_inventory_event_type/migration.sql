-- WI-106: add 'dispatch' to the InventoryEventType enum.
-- Standalone migration: ALTER TYPE ... ADD VALUE must not be bundled with
-- other DDL that uses the value in the same transaction.
ALTER TYPE "InventoryEventType" ADD VALUE IF NOT EXISTS 'dispatch';

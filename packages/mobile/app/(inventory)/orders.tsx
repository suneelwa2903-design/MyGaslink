/**
 * 2026-06-15 — inventory orders: re-exports admin orders.
 *
 * Safe to re-export: (admin)/orders.tsx has zero router.push calls
 * (verified by grep), so it does no cross-route navigation that
 * could leak inventory into the (admin) namespace. Every order
 * endpoint the screen hits — list, create, modify, cancel,
 * dispatch — accepts the inventory role at requireRole.
 *
 * Replaces the prior 216-LOC standalone orders screen.
 */
export { default } from '../(admin)/orders';

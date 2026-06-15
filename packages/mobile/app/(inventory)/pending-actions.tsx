/**
 * 2026-06-15 — inventory pending-actions re-export.
 *
 * Mirrors admin's hidden pending-actions route. Not currently
 * surfaced from any inventory navigation path; registered for
 * completeness so any future router.push('/pending-actions')
 * resolves inside the (inventory) group.
 */
export { default } from '../(admin)/pending-actions';

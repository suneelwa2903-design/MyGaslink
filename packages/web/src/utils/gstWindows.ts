/**
 * GST e-invoice / e-way bill cancellation window helpers.
 *
 * NIC's IRN cancellation API only accepts a cancel request within 24 hours of
 * IRN generation (acknowledgement). Same window applies to EWB cancellation
 * (with the additional restriction that the EWB must not have been verified
 * by a transporter at a checkpost — that side we can't detect from our DB).
 *
 * If the user clicks Cancel after the window has closed, NIC rejects with
 * error 2270 ("IRN cannot be cancelled, as it is generated more than 24 hours
 * back") or similar. The local invoice ends up with irn_status='cancel_failed'
 * and the user is stuck — the only correct compliance path is a credit note
 * for the full amount within the same financial year.
 *
 * Gating the cancel buttons by this client-side window stops users from
 * triggering the failure in the first place.
 */

/**
 * Returns true if the given ISO date string is less than 24 hours in the past.
 *
 * Null / undefined / empty input → false (no date means we don't know it's
 * within the window, so safer to NOT show the cancel affordance).
 */
export function isWithin24Hours(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return false;
  const ageHours = (Date.now() - t) / 3_600_000;
  return ageHours < 24;
}

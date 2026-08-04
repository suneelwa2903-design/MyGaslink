import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useMutation } from '@tanstack/react-query';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { apiPost, getErrorMessage } from '@/lib/api';
import { HiOutlinePaperAirplane } from 'react-icons/hi2';

interface BillingCycleLike {
  cycleId: string;
  invoiceNumber?: string | null;
  periodStartDate: string;
  periodEndDate: string;
  totalAmountInclGst: number;
  dueDate?: string | null;
  razorpayPaymentLink?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  cycle: BillingCycleLike | null;
  distributorName: string;
  defaultRecipient?: string;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function formatMonth(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Mirror of the /api/billing/cycles/:id/send-email response shape.
interface SendResponse {
  sent: boolean;
  to?: string;
  reason?: 'skipped' | 'failed';
  error?: string;
}

// Outer component just gates on open + cycle and remounts the inner body
// whenever the target cycle changes. That way the inner useState calls
// initialise from props on first render only — no setState-in-effect
// dance, and stale edits from a previous send never leak.
export function SendBillingInvoiceModal(props: Props) {
  if (!props.open || !props.cycle) {
    return (
      <Modal open={false} onClose={props.onClose} title="">
        <div />
      </Modal>
    );
  }
  return <SendBillingInvoiceModalBody key={props.cycle.cycleId} {...props} cycle={props.cycle} />;
}

function SendBillingInvoiceModalBody({
  onClose,
  cycle,
  distributorName,
  defaultRecipient,
}: Props & { cycle: NonNullable<Props['cycle']> }) {
  const periodLabel = useMemo(
    () => `${formatDateShort(cycle.periodStartDate)} to ${formatDateShort(cycle.periodEndDate)}`,
    [cycle],
  );
  const monthLabel = useMemo(() => formatMonth(cycle.periodStartDate), [cycle]);
  const dueLabel = useMemo(() => formatDateShort(cycle.dueDate ?? null), [cycle]);

  const [to, setTo] = useState(defaultRecipient ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(`MyGasLink · ${distributorName} · ${monthLabel}`);
  const [body, setBody] = useState(`Please find attached your MyGasLink invoice for ${periodLabel}. Payment due by ${dueLabel}.`);
  const [paymentLink, setPaymentLink] = useState(cycle.razorpayPaymentLink ?? '');

  const trimmedLink = paymentLink.trim();
  const linkLooksValid = trimmedLink.length === 0 || /^https:\/\/[^\s]+$/i.test(trimmedLink);

  const sendMutation = useMutation({
    mutationFn: () => {
      if (!cycle) throw new Error('No cycle selected');
      const ccList = cc
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return apiPost<SendResponse>(`/billing/cycles/${cycle.cycleId}/send-email`, {
        to: to.trim(),
        cc: ccList.length > 0 ? ccList : undefined,
        subject: subject.trim(),
        coverText: body.trim(),
        razorpayPaymentLink: trimmedLink.length > 0 ? trimmedLink : null,
      });
    },
    onSuccess: (result) => {
      if (result.sent) {
        toast.success(`Invoice emailed to ${result.to ?? to}`);
        onClose();
      } else if (result.reason === 'skipped') {
        toast('SMTP not configured on the server. Download the PDF and send manually.', { duration: 6000 });
      } else {
        toast.error(`Email send failed: ${result.error ?? 'unknown error'}`);
      }
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const canSend = to.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0 && linkLooksValid;

  return (
    <Modal
      open
      onClose={onClose}
      title={cycle.invoiceNumber ? `Send invoice ${cycle.invoiceNumber}` : 'Send invoice'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => sendMutation.mutate()}
            loading={sendMutation.isPending}
            disabled={!canSend}
          >
            <HiOutlinePaperAirplane className="h-4 w-4" /> Send Invoice
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-surface-600 dark:text-surface-300 mb-1">To *</label>
            <Input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="finance@distributor.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-surface-600 dark:text-surface-300 mb-1">
              CC <span className="text-surface-400">(comma-separated, optional)</span>
            </label>
            <Input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="accounts@distributor.com"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-surface-600 dark:text-surface-300 mb-1">Subject *</label>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-surface-600 dark:text-surface-300 mb-1">Message *</label>
          <textarea
            className="w-full min-h-[120px] rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 px-3 py-2 text-sm text-surface-900 dark:text-white focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-surface-600 dark:text-surface-300 mb-1">
            Razorpay payment link <span className="text-surface-400">(optional — https:// URL)</span>
          </label>
          <Input
            value={paymentLink}
            onChange={(e) => setPaymentLink(e.target.value)}
            placeholder="https://rzp.io/rzp/xxxxx"
          />
          {!linkLooksValid && (
            <p className="mt-1 text-xs text-red-500">Must start with https://</p>
          )}
          <p className="mt-1 text-xs text-surface-500">
            Create the link in your Razorpay dashboard and paste it here. Adds a Pay Now button to the email. Saved on the invoice so future re-sends reuse the same link.
          </p>
        </div>

        <div className="text-xs text-surface-500 dark:text-surface-400 rounded-lg bg-surface-50 dark:bg-surface-800/40 border border-surface-200 dark:border-surface-700 p-3">
          The invoice PDF (<strong>{cycle.invoiceNumber || 'draft'}.pdf</strong>) is attached automatically.
          {' '}Period: <strong>{periodLabel}</strong>. Due: <strong>{dueLabel}</strong>.
        </div>
      </div>
    </Modal>
  );
}

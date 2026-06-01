/**
 * Shared modal for cancelling an IRN or EWB on the NIC GST portal.
 *
 * GROUP-7S: replaces two near-identical copies that lived inline in
 * BillingPaymentsPage and InvoicesPage. NIC's CANCEL APIs require a
 * structured reason code (CnlRsn '1'-'4') in addition to free-text
 * remarks (CnlRem ≤ 100). The server-side change at the same time made
 * `reasonCode` a required field on POST /invoices/:id/cancel-{irn,ewb}.
 *
 * NIC reason codes:
 *   1 — Duplicate
 *   2 — Data Entry Mistake
 *   3 — Order Cancelled
 *   4 — Others
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, Select } from '@/components/ui';
import { apiPost, getErrorMessage } from '@/lib/api';
import toast from 'react-hot-toast';

export type GstCancelReasonCode = '1' | '2' | '3' | '4';

const REASON_OPTIONS: { value: GstCancelReasonCode; label: string }[] = [
  { value: '1', label: '1 — Duplicate Invoice' },
  { value: '2', label: '2 — Data Entry Mistake' },
  { value: '3', label: '3 — Order Cancelled' },
  { value: '4', label: '4 — Others' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  invoice: { invoiceId: string; invoiceNumber: string };
  type: 'irn' | 'ewb';
}

export function CancelGstModal({ open, onClose, invoice, type }: Props) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState<GstCancelReasonCode | ''>('');

  const mutation = useMutation({
    mutationFn: (data: { reason: string; reasonCode: GstCancelReasonCode }) =>
      apiPost(`/invoices/${invoice.invoiceId}/cancel-${type}`, data),
    onSuccess: () => {
      toast.success(type === 'irn' ? 'IRN cancelled successfully' : 'E-Way Bill cancelled successfully');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setReason('');
      setReasonCode('');
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) { toast.error('Please enter a reason'); return; }
    if (!reasonCode) { toast.error('Please choose a NIC reason code'); return; }
    mutation.mutate({ reason: reason.trim(), reasonCode });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cancel ${type === 'irn' ? 'IRN' : 'E-Way Bill'} for ${invoice.invoiceNumber}`}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-surface-500 dark:text-surface-400">
          This action will cancel the {type === 'irn' ? 'Invoice Registration Number (IRN)' : 'E-Way Bill'} on the GST portal. This cannot be undone.
        </p>
        <Select
          label="NIC reason code"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value as GstCancelReasonCode)}
          options={REASON_OPTIONS}
          placeholder="Select a reason code…"
          required
        />
        <Input
          label="Reason (free text)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Brief explanation (sent to NIC as CnlRem, max 100 chars)"
          maxLength={100}
          required
        />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Go Back</Button>
          <Button type="submit" variant="danger" loading={mutation.isPending}>
            Cancel {type === 'irn' ? 'IRN' : 'EWB'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

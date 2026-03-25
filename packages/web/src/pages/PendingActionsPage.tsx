import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineClock,
} from 'react-icons/hi2';
import {
  type PendingAction,
  PendingActionModule,
  PendingActionStatus,
  PendingActionSeverity,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const SEVERITY_VARIANTS: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  [PendingActionSeverity.CRITICAL]: 'danger',
  [PendingActionSeverity.HIGH]: 'danger',
  [PendingActionSeverity.MEDIUM]: 'warning',
  [PendingActionSeverity.LOW]: 'info',
};

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
  [PendingActionStatus.OPEN]: 'warning',
  [PendingActionStatus.IN_PROGRESS]: 'info',
  [PendingActionStatus.RESOLVED]: 'success',
  [PendingActionStatus.FAILED]: 'danger',
  [PendingActionStatus.SKIPPED]: 'neutral',
};

export default function PendingActionsPage() {
  const queryClient = useQueryClient();
  const [moduleFilter, setModuleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [resolveAction, setResolveAction] = useState<PendingAction | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');

  const queryParams: Record<string, unknown> = {};
  if (moduleFilter) queryParams.module = moduleFilter;
  if (statusFilter) queryParams.status = statusFilter;

  const { data: actions, isLoading } = useQuery({
    queryKey: ['pending-actions', queryParams],
    queryFn: () => apiGet<{ actions: PendingAction[] }>('/pending-actions', queryParams),
    select: (data) => data.actions,
  });

  const approveMutation = useMutation({
    mutationFn: (actionId: string) => apiPost(`/pending-actions/${actionId}/approve`),
    onSuccess: () => {
      toast.success('Action approved');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const rejectMutation = useMutation({
    mutationFn: (actionId: string) => apiPost(`/pending-actions/${actionId}/reject`),
    onSuccess: () => {
      toast.success('Action rejected');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ actionId, notes }: { actionId: string; notes: string }) =>
      apiPost(`/pending-actions/${actionId}/resolve`, { resolutionNotes: notes }),
    onSuccess: () => {
      toast.success('Action resolved');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
      setResolveAction(null);
      setResolutionNotes('');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // Group by module
  const grouped = (actions ?? []).reduce<Record<string, PendingAction[]>>((acc, action) => {
    const key = action.module;
    if (!acc[key]) acc[key] = [];
    acc[key].push(action);
    return acc;
  }, {});

  const moduleOptions = Object.values(PendingActionModule).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));
  const statusOptions = Object.values(PendingActionStatus).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));

  function getSlaStatus(slaDeadline: string | null) {
    if (!slaDeadline) return null;
    const deadline = new Date(slaDeadline);
    const now = new Date();
    const hoursLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursLeft < 0) return { label: 'Overdue', variant: 'danger' as const };
    if (hoursLeft < 4) return { label: `${Math.round(hoursLeft)}h left`, variant: 'danger' as const };
    if (hoursLeft < 24) return { label: `${Math.round(hoursLeft)}h left`, variant: 'warning' as const };
    return { label: `${Math.round(hoursLeft / 24)}d left`, variant: 'info' as const };
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Pending Actions</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Review and resolve pending items</p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select options={moduleOptions} placeholder="All Modules" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} />
          <Select options={statusOptions} placeholder="All Statuses" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : Object.keys(grouped).length === 0 ? (
        <EmptyState title="No pending actions" description="All clear! No items require your attention." />
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([module, moduleActions]) => (
            <div key={module}>
              <h3 className="text-sm font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-500" />
                {module.replace(/_/g, ' ')} ({moduleActions.length})
              </h3>
              <div className="space-y-2">
                {moduleActions.map((action) => {
                  const sla = getSlaStatus(action.slaDeadline);
                  return (
                    <div key={action.actionId} className="card p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <Badge variant={SEVERITY_VARIANTS[action.severity] || 'neutral'}>
                              {action.severity}
                            </Badge>
                            <Badge variant={STATUS_VARIANTS[action.status] || 'neutral'}>
                              {action.status.replace(/_/g, ' ')}
                            </Badge>
                            {sla && (
                              <Badge variant={sla.variant}>
                                <HiOutlineClock className="h-3 w-3 mr-1" />
                                {sla.label}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm font-medium text-surface-900 dark:text-white">{action.description}</p>
                          <p className="text-xs text-surface-400 mt-1">
                            {action.actionType.replace(/_/g, ' ')} | {new Date(action.createdAt).toLocaleString('en-IN')}
                          </p>
                          {action.resolutionNotes && (
                            <p className="text-xs text-accent-500 mt-1">Resolution: {action.resolutionNotes}</p>
                          )}
                        </div>

                        {(action.status === PendingActionStatus.OPEN || action.status === PendingActionStatus.IN_PROGRESS) && (
                          <div className="flex items-center gap-1 shrink-0">
                            {action.requiresApproval && (
                              <>
                                <Button
                                  variant="accent"
                                  size="sm"
                                  onClick={() => approveMutation.mutate(action.actionId)}
                                  loading={approveMutation.isPending}
                                >
                                  <HiOutlineCheckCircle className="h-3 w-3" />
                                  Approve
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => rejectMutation.mutate(action.actionId)}
                                  loading={rejectMutation.isPending}
                                >
                                  <HiOutlineXCircle className="h-3 w-3" />
                                  Reject
                                </Button>
                              </>
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setResolveAction(action)}
                            >
                              Resolve
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Resolve Modal */}
      {resolveAction && (
        <Modal open={!!resolveAction} onClose={() => { setResolveAction(null); setResolutionNotes(''); }} title="Resolve Action">
          <div className="space-y-4">
            <p className="text-sm text-surface-700 dark:text-surface-300">{resolveAction.description}</p>
            <div>
              <label className="label">Resolution Notes</label>
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="input min-h-[100px]"
                placeholder="Describe how this was resolved..."
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => { setResolveAction(null); setResolutionNotes(''); }}>Cancel</Button>
              <Button
                onClick={() => resolveMutation.mutate({ actionId: resolveAction.actionId, notes: resolutionNotes })}
                loading={resolveMutation.isPending}
                disabled={!resolutionNotes.trim()}
              >
                Resolve
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

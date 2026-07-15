/**
 * Feature A (2026-07-15): drill-in modal to manage one group's
 * members and portal access. Tabbed pattern mirrors the customer-
 * detail modal in CustomersPage (border-b-2 + brand-500 active).
 *
 * Members tab — list current members + Add-Customer picker + Remove.
 * Portal Access tab — provision (email + password + first/last name)
 * when no active login exists, else show the existing login + Revoke.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineTrash } from 'react-icons/hi2';
import { apiGet, apiPost, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Modal, Badge, Loader, CustomerSearchInput } from '@/components/ui';
import { cn } from '@/lib/cn';

interface GroupDetail {
  id: string;
  distributorId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{
    id: string;
    groupId: string;
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    customerType: string;
    addedAt: string;
  }>;
  portalUser: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export function GroupModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'members' | 'access'>('members');
  const { data: group, isLoading } = useQuery({
    queryKey: ['customer-group', groupId],
    queryFn: () => apiGet<GroupDetail>(`/customer-groups/${groupId}`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['customer-group', groupId] });
    queryClient.invalidateQueries({ queryKey: ['customer-groups'] });
  };

  return (
    <Modal open onClose={onClose} title={group?.name ?? 'Group'} size="lg">
      {isLoading || !group ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          {/* Tabs — same pattern as the customer detail modal */}
          <div className="border-b border-surface-200 dark:border-surface-700 mb-4">
            <div className="flex gap-4">
              {(['members', 'access'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'pb-2 text-sm font-medium border-b-2 transition-colors',
                    tab === t
                      ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                      : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
                  )}
                >
                  {t === 'members' ? `Members (${group.members.length})` : 'Portal Access'}
                </button>
              ))}
            </div>
          </div>

          {tab === 'members' ? (
            <MembersTab group={group} onChanged={invalidate} />
          ) : (
            <PortalAccessTab group={group} onChanged={invalidate} />
          )}
        </>
      )}
    </Modal>
  );
}

function MembersTab({ group, onChanged }: { group: GroupDetail; onChanged: () => void }) {
  const [pendingCustomerId, setPendingCustomerId] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!pendingCustomerId) return;
    setAdding(true);
    try {
      await apiPost(`/customer-groups/${group.id}/members`, { customerId: pendingCustomerId });
      toast.success('Customer added to group');
      setPendingCustomerId('');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (customerId: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from this group?`)) return;
    try {
      await apiDelete(`/customer-groups/${group.id}/members/${customerId}`);
      toast.success('Removed');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <CustomerSearchInput
            label="Add a property"
            value={pendingCustomerId}
            onChange={(id) => setPendingCustomerId(id)}
            placeholder="Search customer to add..."
          />
        </div>
        <Button onClick={handleAdd} loading={adding} disabled={!pendingCustomerId}>
          Add
        </Button>
      </div>

      {group.members.length === 0 ? (
        <p className="text-sm text-surface-500 dark:text-surface-400 py-4 text-center">
          No properties in this group yet.
        </p>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Property</th>
                <th>GSTIN</th>
                <th>Type</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div>
                      <p className="font-medium text-surface-900 dark:text-white">{m.customerName}</p>
                      {m.businessName && (
                        <p className="text-xs text-surface-500 dark:text-surface-400">{m.businessName}</p>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="text-sm text-surface-600 dark:text-surface-400">{m.gstin ?? '—'}</span>
                  </td>
                  <td><Badge variant="neutral">{m.customerType}</Badge></td>
                  <td>
                    <button
                      onClick={() => handleRemove(m.customerId, m.customerName)}
                      className="p-1.5 text-surface-500 hover:text-red-600"
                      title="Remove from group"
                    >
                      <HiOutlineTrash className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PortalAccessTab({ group, onChanged }: { group: GroupDetail; onChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (email.length < 3 || password.length < 8) {
      toast.error('Fill in email and a password of at least 8 characters');
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/customer-groups/${group.id}/portal-access`, {
        email, password, firstName, lastName,
      });
      toast.success('HQ login created');
      setEmail(''); setPassword(''); setFirstName(''); setLastName('');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    if (!window.confirm(`Revoke access for ${group.portalUser?.email}?`)) return;
    setBusy(true);
    try {
      await apiDelete(`/customer-groups/${group.id}/portal-access`);
      toast.success('Access revoked');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (group.portalUser) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4 space-y-2">
          <p className="text-sm text-surface-500 dark:text-surface-400">Active HQ login</p>
          <p className="text-base font-medium text-surface-900 dark:text-white">
            {group.portalUser.email}
          </p>
          <p className="text-sm text-surface-600 dark:text-surface-400">
            {[group.portalUser.firstName, group.portalUser.lastName].filter(Boolean).join(' ') || '—'}
          </p>
        </div>
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-3">
          <p className="text-sm text-red-800 dark:text-red-300">
            Revoking access soft-deletes this login. You can provision a new one afterwards.
          </p>
          <Button variant="secondary" onClick={handleRevoke} loading={busy}>
            Revoke access
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleProvision} className="space-y-4">
      <p className="text-sm text-surface-500 dark:text-surface-400">
        Create an HQ login for this group. The user can log in on the web to see consolidated
        orders, invoices, ledger and aging across all group members.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} />
        <Input label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} />
      </div>
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hq@example.com" />
      <Input label="Temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
      <p className="text-xs text-surface-500 dark:text-surface-400">
        The user will be forced to change this password on first login.
      </p>
      <div className="flex justify-end">
        <Button type="submit" loading={busy} disabled={email.length < 3 || password.length < 8}>
          Create HQ login
        </Button>
      </div>
    </form>
  );
}

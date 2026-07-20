/**
 * Feature A (2026-07-15): drill-in modal to manage one group's
 * members and portal access. Tabbed pattern mirrors the customer-
 * detail modal in CustomersPage (border-b-2 + brand-500 active).
 *
 * Members tab — list current members + Add-Customer picker + Remove.
 * Portal Access tab — list of active HQ logins with per-row Revoke,
 * plus an Add-HQ-login form that supports either promoting an
 * existing customer contact (Mode: "Pick from contacts") or entering
 * details manually (Mode: "Create new"). Multiple HQ logins per
 * group are allowed as of 2026-07-15 evening.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlineUser } from 'react-icons/hi2';
import { apiGet, apiPost, apiPatch, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Modal, Badge, Loader, CustomerSearchInput } from '@/components/ui';
import { cn } from '@/lib/cn';

interface PortalUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  sourceContactId: string | null;
  sourceContactName: string | null;
  sourceCustomerId: string | null;
  sourceCustomerName: string | null;
}

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
    // 2026-07-20: optional short alias shown on HQ portal surfaces in
    // place of customerName. Null → HQ users see the real customerName.
    displayName: string | null;
  }>;
  portalUsers: PortalUser[];
}

interface CandidateContact {
  contactId: string;
  name: string;
  email: string | null;
  phone: string;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
  hasLogin: boolean;
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
    queryClient.invalidateQueries({ queryKey: ['group-contacts', groupId] });
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
                  {t === 'members' ? `Members (${group.members.length})` : `Portal Access (${group.portalUsers.length})`}
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
  // 2026-07-20: optional alias at add-time — the primary UX for
  // fitting long customer names into the group ledger Property column.
  const [pendingDisplayName, setPendingDisplayName] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!pendingCustomerId) return;
    setAdding(true);
    try {
      await apiPost(`/customer-groups/${group.id}/members`, {
        customerId: pendingCustomerId,
        displayName: pendingDisplayName.trim() || undefined,
      });
      toast.success('Customer added to group');
      setPendingCustomerId('');
      setPendingDisplayName('');
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
      <div className="grid grid-cols-1 sm:grid-cols-[1fr,240px,auto] gap-2 items-end">
        <CustomerSearchInput
          label="Add a property"
          value={pendingCustomerId}
          onChange={(id) => setPendingCustomerId(id)}
          placeholder="Search customer to add..."
        />
        <Input
          label="Display name (optional)"
          value={pendingDisplayName}
          onChange={(e) => setPendingDisplayName(e.target.value)}
          placeholder="e.g. Axolotl"
          maxLength={80}
        />
        <Button onClick={handleAdd} loading={adding} disabled={!pendingCustomerId}>
          Add
        </Button>
      </div>
      <p className="text-xs text-surface-500 dark:text-surface-400 -mt-2">
        The display name appears in the HQ portal Property column (ledger, payments, orders, invoices) in place of the full customer name — the underlying customer record is untouched.
      </p>

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
                <th>Display name (HQ)</th>
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
                    <InlineDisplayNameEditor
                      groupId={group.id}
                      customerId={m.customerId}
                      value={m.displayName}
                      onSaved={onChanged}
                    />
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

/**
 * 2026-07-20: inline per-row editor for a member's HQ display alias.
 * Saves on Enter / blur when dirty; clears back to fallback on empty
 * (PATCH sends null so readers use customer.customerName again).
 */
function InlineDisplayNameEditor({
  groupId,
  customerId,
  value,
  onSaved,
}: {
  groupId: string;
  customerId: string;
  value: string | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = (value ?? '') !== draft.trim();

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await apiPatch(`/customer-groups/${groupId}/members/${customerId}`, {
        displayName: draft.trim() || null,
      });
      toast.success('Alias updated');
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err));
      setDraft(value ?? '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
      disabled={saving}
      maxLength={80}
      placeholder="—"
      className="w-full max-w-[220px] rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1 text-sm text-surface-900 dark:text-white focus:border-brand-500 focus:outline-none disabled:opacity-50"
    />
  );
}

function PortalAccessTab({ group, onChanged }: { group: GroupDetail; onChanged: () => void }) {
  const [mode, setMode] = useState<'contact' | 'freeform'>('contact');
  const [sourceContactId, setSourceContactId] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // Load candidate contacts for the picker. Small list (typically <
  // 30 for a hotel chain group) so no pagination needed. staleTime
  // 60s so a Add-Contact on another tab reflects here quickly.
  const { data: contactsData } = useQuery({
    queryKey: ['group-contacts', group.id],
    queryFn: () => apiGet<{ contacts: CandidateContact[] }>(`/customer-groups/${group.id}/contacts`),
    staleTime: 60_000,
  });
  const contacts = contactsData?.contacts ?? [];

  const handlePickContact = (contactId: string) => {
    setSourceContactId(contactId);
    const contact = contacts.find((c) => c.contactId === contactId);
    if (contact) {
      if (contact.email) setEmail(contact.email);
      // Split "First Last" — mid-string spaces go into last name so we
      // don't lose them. If the contact only has one word, put it in
      // firstName and blank the last.
      const parts = contact.name.trim().split(/\s+/);
      setFirstName(parts[0] ?? '');
      setLastName(parts.slice(1).join(' '));
    }
  };

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (email.length < 3 || password.length < 8 || !firstName || !lastName) {
      toast.error('Fill in first name, last name, email, and a password of at least 8 characters');
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/customer-groups/${group.id}/portal-access`, {
        email,
        password,
        firstName,
        lastName,
        sourceContactId: sourceContactId || undefined,
      });
      toast.success('HQ login created');
      setSourceContactId(''); setEmail(''); setPassword(''); setFirstName(''); setLastName('');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (u: PortalUser) => {
    if (!window.confirm(`Revoke access for ${u.email}?`)) return;
    try {
      await apiDelete(`/customer-groups/${group.id}/portal-access/${u.id}`);
      toast.success('Access revoked');
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Existing HQ logins list ── */}
      {group.portalUsers.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
            Active HQ logins
          </p>
          <div className="space-y-2">
            {group.portalUsers.map((u) => (
              <div
                key={u.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-surface-200 dark:border-surface-700 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-surface-900 dark:text-white truncate">
                    {u.email}
                  </p>
                  <p className="text-xs text-surface-500 dark:text-surface-400">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                  </p>
                  {u.sourceContactName && u.sourceCustomerName && (
                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-1 flex items-center gap-1">
                      <HiOutlineUser className="h-3 w-3" />
                      Contact of <span className="font-medium">{u.sourceCustomerName}</span>
                      {' · '}{u.sourceContactName}
                    </p>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleRevoke(u)}
                  disabled={busy}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          No HQ logins yet. Add one below.
        </p>
      )}

      {/* ── Add a new HQ login ── */}
      <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4 space-y-4">
        <div>
          <p className="text-sm font-medium text-surface-900 dark:text-white">
            {group.portalUsers.length === 0 ? 'Create HQ login' : 'Add another HQ login'}
          </p>
          <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
            HQ users see consolidated orders / invoices / ledger / aging across all group members. They cannot place orders or make payments.
          </p>
        </div>

        {/* Mode toggle */}
        <div className="inline-flex rounded-md border border-surface-200 dark:border-surface-700 overflow-hidden">
          {(['contact', 'freeform'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                mode === m
                  ? 'bg-brand-500 text-white'
                  : 'bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
              )}
            >
              {m === 'contact' ? 'Pick from contacts' : 'Create new'}
            </button>
          ))}
        </div>

        <form onSubmit={handleProvision} className="space-y-3">
          {mode === 'contact' ? (
            <div>
              <label className="label" htmlFor="hq-contact-picker">Contact</label>
              <select
                id="hq-contact-picker"
                className="select"
                value={sourceContactId}
                onChange={(e) => handlePickContact(e.target.value)}
              >
                <option value="">Choose a contact to promote…</option>
                {contacts.length === 0 && (
                  <option disabled>No contacts on any group member yet</option>
                )}
                {contacts.map((c) => (
                  <option
                    key={c.contactId}
                    value={c.contactId}
                    disabled={c.hasLogin}
                  >
                    {c.name} — {c.customerName}{c.email ? ` · ${c.email}` : ''}{c.hasLogin ? ' (already promoted)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                Picking a contact prefills the fields below and tags the HQ login to that customer so you can always trace who this person is.
              </p>
            </div>
          ) : (
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Use this mode when the HQ user is not listed as a contact of any single member (e.g. a corporate accounting staff member).
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} required />
            <Input label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} required />
          </div>
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hq@example.com" required />
          <Input label="Temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required />
          <p className="text-xs text-surface-500 dark:text-surface-400">
            The user will be forced to change this password on first login.
          </p>
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={email.length < 3 || password.length < 8 || !firstName || !lastName}>
              {group.portalUsers.length === 0 ? 'Create HQ login' : 'Add HQ login'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

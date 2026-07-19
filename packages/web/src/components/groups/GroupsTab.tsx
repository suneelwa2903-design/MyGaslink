/**
 * Feature A (2026-07-15): Groups tab rendered under the Customers page.
 *
 * Distributor-facing management of HQ CustomerGroups. Shows a table of
 * groups with member count + portal-access status, offers "New Group"
 * (rename inline via edit modal), row actions to open the drill-in
 * GroupModal (members + portal access), and delete with a portal-
 * revoke reminder.
 *
 * Roles: same set as customer create — super_admin / distributor_admin
 * / finance / inventory. Route-level guards are the source of truth;
 * the UI hides mutation buttons for roles that don't have access.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineUserGroup,
} from 'react-icons/hi2';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Badge, Loader, EmptyState, Modal, Input } from '@/components/ui';
import { useAuthStore, selectRole } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { GroupModal } from './GroupModal';

interface GroupRow {
  id: string;
  distributorId: string;
  name: string;
  memberCount: number;
  hasPortalAccess: boolean;
  // Feature A follow-up (2026-07-15): multi-HQ per group. `portalEmails`
  // shows up to 3 emails for the list card; `portalUserCount` is the
  // authoritative total (may exceed emails.length).
  portalEmails: string[];
  portalUserCount: number;
  createdAt: string;
  updatedAt: string;
}

export function GroupsTab() {
  const queryClient = useQueryClient();
  const role = useAuthStore(selectRole);
  const canManage =
    role === UserRole.DISTRIBUTOR_ADMIN ||
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.FINANCE ||
    role === UserRole.INVENTORY;

  const [createOpen, setCreateOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupRow | null>(null);
  const [managingGroupId, setManagingGroupId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['customer-groups'],
    queryFn: () => apiGet<{ groups: GroupRow[] }>('/customer-groups'),
  });
  const groups = data?.groups ?? [];

  const deleteMutation = useMutation({
    mutationFn: async (groupId: string) => {
      await apiDelete(`/customer-groups/${groupId}`);
    },
    onSuccess: () => {
      toast.success('Group deleted');
      queryClient.invalidateQueries({ queryKey: ['customer-groups'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const handleDelete = (g: GroupRow) => {
    if (g.hasPortalAccess) {
      toast.error('Revoke portal access first, then delete the group.');
      return;
    }
    if (!window.confirm(`Delete group "${g.name}"? Members stay as customers; only the group is removed.`)) return;
    deleteMutation.mutate(g.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Group multiple B2B customer records under one HQ login (e.g. hotel chains, multi-branch dealers).
        </p>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" />
            New Group
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : groups.length === 0 ? (
        <EmptyState
          title="No groups yet"
          description="Create a group to give an HQ user consolidated visibility across multiple properties."
          action={
            canManage ? (
              <Button onClick={() => setCreateOpen(true)}>
                <HiOutlinePlus className="h-4 w-4" />
                Create Group
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Group Name</th>
                <th>Members</th>
                <th>Portal Access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <HiOutlineUserGroup className="h-4 w-4 text-surface-400" />
                      <span className="font-medium text-surface-900 dark:text-white">{g.name}</span>
                    </div>
                  </td>
                  <td>
                    <span className="text-sm text-surface-700 dark:text-surface-300">
                      {g.memberCount} {g.memberCount === 1 ? 'property' : 'properties'}
                    </span>
                  </td>
                  <td>
                    {g.hasPortalAccess ? (
                      // items-start keeps the badge shrink-to-content
                      // so the green pill doesn't stretch the whole
                      // column when emails below it are longer than
                      // the badge text.
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="success">
                          {g.portalUserCount === 1
                            ? 'Active'
                            : `Active (${g.portalUserCount})`}
                        </Badge>
                        <div className="flex flex-col gap-0.5 leading-tight">
                          {g.portalEmails.slice(0, 2).map((e) => (
                            <span key={e} className="text-xs text-surface-500 dark:text-surface-400">{e}</span>
                          ))}
                          {g.portalUserCount > 2 && (
                            <span className="text-xs text-surface-400 italic">
                              +{g.portalUserCount - 2} more
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <Badge variant="neutral">Not set up</Badge>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setManagingGroupId(g.id)}>
                        Manage
                      </Button>
                      {canManage && (
                        <>
                          <button
                            onClick={() => setEditingGroup(g)}
                            className="p-1.5 text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
                            title="Rename group"
                          >
                            <HiOutlinePencilSquare className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(g)}
                            className="p-1.5 text-surface-500 hover:text-red-600"
                            title="Delete group"
                          >
                            <HiOutlineTrash className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <GroupNameFormModal
          title="New Group"
          onClose={() => setCreateOpen(false)}
          onSubmit={async (name) => {
            await apiPost('/customer-groups', { name });
            toast.success('Group created');
            queryClient.invalidateQueries({ queryKey: ['customer-groups'] });
            setCreateOpen(false);
          }}
        />
      )}

      {editingGroup && (
        <GroupNameFormModal
          title="Rename Group"
          initialName={editingGroup.name}
          onClose={() => setEditingGroup(null)}
          onSubmit={async (name) => {
            await apiPut(`/customer-groups/${editingGroup.id}`, { name });
            toast.success('Group renamed');
            queryClient.invalidateQueries({ queryKey: ['customer-groups'] });
            setEditingGroup(null);
          }}
        />
      )}

      {managingGroupId && (
        <GroupModal
          groupId={managingGroupId}
          onClose={() => setManagingGroupId(null)}
        />
      )}
    </div>
  );
}

/**
 * Small shared name-only modal used for both Create and Rename flows.
 * Inlined here rather than a separate file — it's ~30 lines and only
 * ever used by GroupsTab.
 */
function GroupNameFormModal({
  title,
  initialName,
  onClose,
  onSubmit,
}: {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [submitting, setSubmitting] = useState(false);
  return (
    <Modal open onClose={onClose} title={title}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim().length < 1) return;
          setSubmitting(true);
          try { await onSubmit(name.trim()); }
          catch (err) { toast.error(getErrorMessage(err)); }
          finally { setSubmitting(false); }
        }}
        className="space-y-4"
      >
        <Input
          label="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Kinara Group of Hotels"
          maxLength={100}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={submitting} disabled={name.trim().length < 1}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

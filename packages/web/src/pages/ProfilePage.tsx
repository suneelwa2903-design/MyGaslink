import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlineUser, HiOutlineEnvelope, HiOutlinePhone, HiOutlineBriefcase,
  HiOutlineBuildingOffice, HiOutlineClock, HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import { changePasswordSchema, type ChangePasswordInput } from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Badge, Loader, EmptyState, Modal } from '@/components/ui';

interface UserProfile {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: string;
  status: string;
  distributorId: string | null;
  customerId: string | null;
  requiresPasswordReset: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  distributor?: { id: string; businessName: string; status: string } | null;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  distributor_admin: 'Distributor Admin',
  finance: 'Finance',
  inventory: 'Inventory',
  driver: 'Driver',
  customer: 'Customer',
};

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile page for staff roles (admin, finance, inventory, super_admin).
// Customer role has its own page at /app/customer/account.
//
// Sections:
//   1. Read-only identity (name, email, phone, role, distributor, last login)
//   2. Change Password (uses POST /api/auth/change-password)
//   3. Delete Account (modal — POST /api/users/me/deletion-request)
//   4. Sign Out
//
// Account deletion mirrors the mobile (shared)/delete-account flow shipped
// in M14 v1.0. Same 30-day grace; same disclosure copy locked in
// IOS-ACCOUNT-DELETION-SPEC §7.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_CONFIRM = 'DELETE MY ACCOUNT';

export default function ProfilePage() {
  const navigate = useNavigate();
  const { logout } = useAuthStore();
  const [pwOpen, setPwOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['my-profile'],
    queryFn: () => apiGet<UserProfile>('/users/profile'),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
  if (error || !profile) return <EmptyState title="Unable to load profile" description="Try refreshing the page." />;

  const fullName = `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() || profile.email;
  const initials = (profile.firstName?.[0] ?? '') + (profile.lastName?.[0] ?? '');
  const roleLabel = ROLE_LABEL[profile.role] ?? profile.role;

  const handleSignOut = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">My Profile</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          Your account details and security settings.
        </p>
      </div>

      {/* Identity card */}
      <div className="card p-6">
        <div className="flex items-start gap-4">
          <div className="h-14 w-14 rounded-full bg-brand-100 dark:bg-brand-500/20 flex items-center justify-center text-brand-600 dark:text-brand-400 text-xl font-bold uppercase shrink-0">
            {initials || <HiOutlineUser className="h-7 w-7" />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-surface-900 dark:text-white">{fullName}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Badge variant="neutral">{roleLabel}</Badge>
              {profile.status === 'active' ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="warning">{profile.status}</Badge>
              )}
              {profile.requiresPasswordReset && (
                <Badge variant="warning">Password reset required</Badge>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6 text-sm">
          <Field icon={HiOutlineEnvelope} label="Email" value={profile.email} />
          <Field icon={HiOutlinePhone} label="Phone" value={profile.phone || '—'} />
          <Field icon={HiOutlineBriefcase} label="Role" value={roleLabel} />
          <Field
            icon={HiOutlineBuildingOffice}
            label="Distributor"
            value={profile.distributor?.businessName ?? (profile.distributorId ?? '—')}
          />
          <Field icon={HiOutlineClock} label="Last login" value={formatDate(profile.lastLoginAt)} />
          <Field icon={HiOutlineClock} label="Account created" value={formatDate(profile.createdAt)} />
        </div>
      </div>

      {/* Security */}
      <div className="card p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-surface-900 dark:text-white">Security</h3>
          <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
            Manage your password and active session.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setPwOpen(true)}>
            Change Password
          </Button>
          <Button variant="ghost" onClick={handleSignOut}>
            Sign Out
          </Button>
        </div>
      </div>

      {/* Danger zone — Delete Account */}
      {profile.role !== 'super_admin' && (
        <div className="card p-6 border-2 border-rose-200 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-950/10 space-y-4">
          <div className="flex items-start gap-3">
            <HiOutlineExclamationTriangle className="h-5 w-5 text-rose-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-base font-semibold text-rose-900 dark:text-rose-200">Delete Account</h3>
              <p className="text-xs text-rose-700/80 dark:text-rose-300/80 mt-1">
                Submit a deletion request. Your personal information is removed within 30 days.
                Financial records are retained anonymously for 8 years per Indian GST law. You
                can cancel within 30 days by signing back in.
              </p>
            </div>
          </div>
          <Button variant="danger" onClick={() => setDelOpen(true)}>
            Request Account Deletion
          </Button>
        </div>
      )}

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
      {delOpen && (
        <DeleteAccountModal
          onClose={() => setDelOpen(false)}
          onSubmitted={async () => {
            await logout();
            navigate('/login');
          }}
        />
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function Field({
  icon: Icon, label, value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="h-5 w-5 text-surface-400 dark:text-surface-500 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-surface-500 dark:text-surface-400">{label}</div>
        <div className="text-sm text-surface-900 dark:text-white truncate">{value}</div>
      </div>
    </div>
  );
}

// ─── Change Password Modal ──────────────────────────────────────────────────

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
  });

  const mutation = useMutation({
    mutationFn: (data: ChangePasswordInput) => apiPost('/auth/change-password', data),
    onSuccess: () => {
      toast.success('Password updated');
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal open onClose={onClose} title="Change Password" size="md">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
        <Input
          type="password"
          label="Current Password"
          autoComplete="current-password"
          {...register('currentPassword')}
          error={errors.currentPassword?.message}
        />
        <Input
          type="password"
          label="New Password"
          autoComplete="new-password"
          {...register('newPassword')}
          error={errors.newPassword?.message}
        />
        <Input
          type="password"
          label="Confirm New Password"
          autoComplete="new-password"
          {...register('confirmPassword')}
          error={errors.confirmPassword?.message}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Updating…' : 'Update Password'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Delete Account Modal ───────────────────────────────────────────────────

function DeleteAccountModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => Promise<void> }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => apiPost('/users/me/deletion-request', {
      confirmText: REQUIRED_CONFIRM,
      reason: reason.trim() || undefined,
    }),
    onSuccess: async () => {
      toast.success('Deletion request submitted. You have 30 days to cancel by signing back in.');
      await onSubmitted();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const enabled = typed === REQUIRED_CONFIRM && !mutation.isPending;

  return (
    <Modal open onClose={onClose} title="Request Account Deletion" size="lg">
      <div className="space-y-4 text-sm text-surface-700 dark:text-surface-300 leading-relaxed">
        <p>
          Your account deletion request will be submitted. Your personal information — name,
          email, phone, address — will be removed within 30 days.
        </p>
        <p>You can cancel this request anytime in those 30 days by signing back in.</p>
        <p>
          After 30 days, as required by Indian Income Tax and GST law, your invoice and payment
          history will be retained anonymously for 8 years. Anonymized records are linked to a
          random ID — not to you — and are used only for statutory tax compliance and audit,
          never for marketing or analytics. After 8 years, all records are permanently deleted.
        </p>
        <p className="font-semibold text-rose-600 dark:text-rose-400">
          This cannot be undone after 30 days.
        </p>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-surface-600 dark:text-surface-400 mb-1">
            Type <span className="text-rose-600">{REQUIRED_CONFIRM}</span> to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={mutation.isPending}
            className="input w-full"
            autoCapitalize="characters"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-surface-600 dark:text-surface-400 mb-1">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={mutation.isPending}
            rows={3}
            className="input w-full"
            placeholder="Help us understand why you're leaving"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!enabled} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Submitting…' : 'Submit Request'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

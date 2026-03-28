import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { changePasswordSchema, type ChangePasswordInput } from '@gaslink/shared';
import { apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input } from '@/components/ui';

export default function ForcePasswordResetPage() {
  const navigate = useNavigate();
  const { logout } = useAuthStore();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: ChangePasswordInput) =>
      apiPost('/auth/change-password', {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        confirmPassword: data.confirmPassword,
      }),
    onSuccess: () => {
      toast.success('Password changed successfully. Please log in again.');
      logout();
      navigate('/login', { replace: true });
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 dark:bg-surface-950 px-4 py-12">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-flame-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-brand-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-flame-500 text-white font-bold text-xl mb-4">
            GL
          </div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
            Password Reset Required
          </h1>
          <p className="mt-2 text-sm text-surface-500 dark:text-surface-400">
            Your administrator requires you to change your password before continuing.
          </p>
        </div>

        <div className="card p-6 sm:p-8">
          <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
            <Input
              label="Current Password"
              type="password"
              placeholder="Enter current password"
              autoComplete="current-password"
              error={errors.currentPassword?.message}
              {...register('currentPassword')}
            />

            <Input
              label="New Password"
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              error={errors.newPassword?.message}
              {...register('newPassword')}
            />

            <Input
              label="Confirm New Password"
              type="password"
              placeholder="Re-enter new password"
              autoComplete="new-password"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />

            <Button
              type="submit"
              className="w-full"
              size="lg"
              loading={mutation.isPending}
            >
              Change Password
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

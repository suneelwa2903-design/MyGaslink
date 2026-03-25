import { HiOutlineExclamationTriangle, HiOutlineEnvelope, HiOutlinePhone } from 'react-icons/hi2';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui';

export default function BillingSuspendedPage() {
  const { logout } = useAuthStore();

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-lg">
        <div className="flex justify-center mb-6">
          <div className="h-20 w-20 rounded-full bg-red-100 dark:bg-red-500/10 flex items-center justify-center">
            <HiOutlineExclamationTriangle className="h-10 w-10 text-red-500" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-surface-900 dark:text-white mb-2">
          Billing Suspended
        </h1>

        <p className="text-surface-500 dark:text-surface-400 mb-6">
          Your account has been suspended due to an outstanding billing issue.
          Please contact our support team to resolve this and restore access to your account.
        </p>

        <div className="card p-6 mb-6 text-left space-y-3">
          <h3 className="font-semibold text-surface-900 dark:text-white">Contact Support</h3>
          <div className="flex items-center gap-3 text-sm text-surface-600 dark:text-surface-300">
            <HiOutlineEnvelope className="h-5 w-5 text-brand-500 shrink-0" />
            <a href="mailto:support@mygaslink.com" className="text-brand-500 hover:underline">support@mygaslink.com</a>
          </div>
          <div className="flex items-center gap-3 text-sm text-surface-600 dark:text-surface-300">
            <HiOutlinePhone className="h-5 w-5 text-brand-500 shrink-0" />
            <a href="tel:+919876543210" className="text-brand-500 hover:underline">+91 98765 43210</a>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Refresh Page
          </Button>
          <Button variant="ghost" onClick={() => { logout(); window.location.href = '/login'; }}>
            Log Out
          </Button>
        </div>
      </div>
    </div>
  );
}

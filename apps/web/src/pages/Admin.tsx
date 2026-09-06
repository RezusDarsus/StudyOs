import { Shield } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import RegistrationIpPanel from '../components/RegistrationIpPanel';
import { useAuth } from '../lib/auth';

/** Administrative tools. The API remains the authority for every data request. */
export default function Admin() {
  const { user } = useAuth();

  if (!user?.isAdmin) return <Navigate to="/app" replace />;

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <header className="flex items-start gap-3 mb-6">
        <span
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 42, height: 42, background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}
          aria-hidden="true"
        >
          <Shield size={19} style={{ color: 'var(--text-body)' }} />
        </span>
        <div>
          <h1 style={{ fontSize: 'clamp(1.45rem, 2.5vw, 1.9rem)', color: 'var(--text)', letterSpacing: '-0.03em' }}>
            Admin
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-body)', fontSize: '0.88rem' }}>
            Restricted operational views for configured administrators.
          </p>
        </div>
      </header>
      <RegistrationIpPanel />
    </div>
  );
}

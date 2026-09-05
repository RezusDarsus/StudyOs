import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorState, useAsync } from './ui';

interface RegistrationIps {
  totalAccounts: number;
  unknownAccounts: number;
  hasMore: boolean;
  groups: Array<{ ip: string; accounts: number }>;
}

export default function RegistrationIpPanel() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useAsync(
    () => api.get<RegistrationIps>(`/admin/registration-ips?page=${page}`), [page],
  );
  return <section className="card p-5 sm:p-6 mb-5" aria-labelledby="registration-ip-title">
    <h2 id="registration-ip-title" className="font-semibold text-lg mb-2">Admin · Registrations by IP</h2>
    <p className="text-sm mb-4">Accounts grouped by the IP recorded at signup. Shared networks can have several accounts.</p>
    {loading ? <p role="status">Loading registration counts…</p> : error ? <ErrorState message={error} onRetry={reload} /> : data && <>
      <p className="text-sm mb-4">{data.totalAccounts.toLocaleString()} accounts · {data.unknownAccounts.toLocaleString()} with IP not recorded</p>
      {data.groups.length ? <table className="w-full text-left" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <caption className="sr-only">Registered accounts per IP, highest count first</caption>
        <thead><tr><th scope="col" className="py-2">Registration IP</th><th scope="col" className="py-2 text-right">Accounts</th></tr></thead>
        <tbody>{data.groups.map((group) => <tr key={group.ip}>
          <td className="py-2 pr-3" style={{ overflowWrap: 'anywhere' }}>{group.ip}</td>
          <td className="py-2 text-right">{group.accounts.toLocaleString()}</td>
        </tr>)}</tbody>
      </table> : <p>No registration IPs recorded yet.</p>}
      <div className="flex items-center justify-between gap-3 mt-4">
        <button className="btn btn-secondary px-4 py-2" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="text-sm">Page {page}</span>
        <button className="btn btn-secondary px-4 py-2" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </>}
  </section>;
}

import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { isManager } from '../../shared/workflow';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import './styles/tokens.css';
import './styles/app.css';
import { api, queryClient } from './api';
import type { Bootstrap } from '../../shared/types';
import { AppShell } from './components/Shell';
import { ErrorState, ToastProvider } from './components/ui';
import { Login, type AuthStatus } from './pages/Login';
import { Overview } from './pages/Overview';
import { MyWorkPage } from './pages/MyWork';
import { Production } from './pages/Production';
import { CalendarPage } from './pages/Calendar';
import { ClientPage, ClientsPage } from './pages/Clients';
import { BatchPage } from './pages/BatchDetail';
import { ReviewPage } from './pages/Review';
import { ResourcesPage } from './pages/Resources';
import { ScriptBankPage } from './pages/ScriptBank';
import { WritersPage } from './pages/Writers';
import { SettingsPage } from './pages/Settings';
import { MasterLogPage } from './pages/MasterLog';
import { WhatsNewPage } from './pages/WhatsNew';
import { MotionProvider } from './motion';
import { loadControlCenter } from './control/leave';
import { applyRememberedTheme, applyTheme } from './theme';

applyRememberedTheme();

// The Control Center is its own world (and brings three.js), so it loads only when visited.
const ControlCenter = lazy(loadControlCenter);

function Gate() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<AuthStatus>('/api/auth/status'), staleTime: Infinity });
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap'), enabled: !!status.data?.signedIn, refetchInterval: 60_000 });
  useEffect(() => {
    const lost = () => { queryClient.clear(); status.refetch(); };
    window.addEventListener('auth:lost', lost);
    return () => window.removeEventListener('auth:lost', lost);
  }, [status]);

  // the admin's colour palette, for everyone (the sign-in page included)
  const theme = boot.data ? boot.data.settings.theme : status.data?.theme;
  const themeKey = JSON.stringify(theme ?? null);
  useEffect(() => { if (theme !== undefined) applyTheme(theme); }, [themeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status.isLoading || (status.data?.signedIn && boot.isLoading)) {
    return <div className="loading-center" role="status"><span className="wordmark" style={{ fontSize: 28 }}>Scale&nbsp;<span>Media</span></span><span>Loading…</span></div>;
  }
  if (status.isError) return <main className="login"><ErrorState error={status.error} retry={() => status.refetch()} /></main>;
  if (!status.data!.signedIn) return <Login status={status.data!} onDone={() => { queryClient.clear(); status.refetch(); }} />;
  if (boot.isError || !boot.data) return <main className="login"><ErrorState error={boot.error} retry={() => boot.refetch()} /></main>;
  const home = isManager(boot.data.me.role) ? '/overview' : '/my-work';
  return (
    <Routes>
      <Route element={<AppShell boot={boot.data} />}>
        <Route index element={<Navigate to={home} replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/my-work" element={<MyWorkPage />} />
        <Route path="/production" element={<Production />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/clients/:id" element={<ClientPage />} />
        <Route path="/batches/:id" element={<BatchPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/scripts" element={<ScriptBankPage />} />
        <Route path="/writers" element={<WritersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/log" element={<MasterLogPage />} />
        <Route path="/whats-new" element={<WhatsNewPage />} />
        <Route path="*" element={<div className="panel"><h2>Page not found</h2><p className="muted" style={{ marginTop: 8 }}>That page doesn’t exist.</p></div>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/control-center/*" element={<Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#010206' }} />}><ControlCenter /></Suspense>} />
              <Route path="*" element={<Gate />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

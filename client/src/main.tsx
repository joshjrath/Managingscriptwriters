import { StrictMode, useEffect, type ReactElement } from 'react';
import { isManager } from '../../shared/workflow';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import './styles/tokens.css';
import './styles/app.css';
import { api, queryClient, setRecordingMode } from './api';
import type { Bootstrap } from '../../shared/types';
import { AppShell } from './components/Shell';
import { ErrorState, NotFound, ToastProvider } from './components/ui';
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
import { EditorHome } from './pages/EditorHome';
import { SettingsPage } from './pages/Settings';
import { MasterLogPage } from './pages/MasterLog';
import { WhatsNewPage } from './pages/WhatsNew';
import { MotionProvider } from './motion';
import { applyRememberedTheme, applyTheme } from './theme';

applyRememberedTheme();

function Gate() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<AuthStatus>('/api/auth/status'), staleTime: Infinity });
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap'), enabled: !!status.data?.signedIn, refetchInterval: 60_000 });
  useEffect(() => {
    const lost = () => { setRecordingMode(null); queryClient.clear(); void status.refetch(); };
    window.addEventListener('auth:lost', lost);
    return () => window.removeEventListener('auth:lost', lost);
  }, [status]);

  // While recording, every request names its practice copy, so nothing reaches the real workspace once
  // it's gone. The name is kept for the life of the page, even after the bootstrap stops reporting a
  // recording (that's exactly when the copy is gone): turning recording off reloads the page, and a
  // new sign-in starts without one.
  const recordingSince = boot.data?.mode?.recording?.startedAt ?? null;
  useEffect(() => { if (recordingSince) setRecordingMode(recordingSince); }, [recordingSince]);

  // the admin's colour palette, for everyone (the sign-in page included)
  const theme = boot.data ? boot.data.settings.theme : status.data?.theme;
  const themeKey = JSON.stringify(theme ?? null);
  useEffect(() => { if (theme !== undefined) applyTheme(theme); }, [themeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status.isLoading || (status.data?.signedIn && boot.isLoading)) {
    return <div className="loading-center" role="status"><span className="wordmark" style={{ fontSize: 28 }}>SCALE&nbsp;<span>Media</span></span><span>Loading…</span></div>;
  }
  if (status.isError) return <main className="login"><ErrorState error={status.error} retry={() => status.refetch()} /></main>;
  // signed out without pressing Sign out (a password reset, or the session ended): say so
  let signedOut = false;
  try {
    if (status.data!.signedIn) localStorage.setItem('sm.signed-in', '1');
    else signedOut = localStorage.getItem('sm.signed-in') === '1';
  } catch { /* ignore */ }
  if (!status.data!.signedIn) return <Login status={status.data!} signedOut={signedOut} onDone={() => { setRecordingMode(null); queryClient.clear(); void status.refetch(); }} />;
  if (boot.isError || !boot.data) return <main className="login"><ErrorState error={boot.error} retry={() => boot.refetch()} /></main>;
  const role = boot.data.me.role;
  const home = isManager(role) ? '/overview' : role === 'editor' ? '/editor' : '/my-work';
  // editors only have their own pages; anything else takes them home
  const only = (el: ReactElement) => (role === 'editor' ? <Navigate to="/editor" replace /> : el);
  // the review queue (other writers' feedback) and the team page are for managers
  const managers = (el: ReactElement) => (isManager(role) ? el : <Navigate to={home} replace />);
  return (
    <Routes>
      <Route element={<AppShell boot={boot.data} />}>
        <Route index element={<Navigate to={home} replace />} />
        <Route path="/editor" element={role === 'editor' || isManager(role) ? <EditorHome /> : <Navigate to={home} replace />} />
        <Route path="/overview" element={only(<Overview />)} />
        <Route path="/my-work" element={only(<MyWorkPage />)} />
        <Route path="/production" element={only(<Production />)} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/clients/:id" element={<ClientPage />} />
        <Route path="/batches/:id" element={only(<BatchPage />)} />
        <Route path="/review" element={managers(<ReviewPage />)} />
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/scripts" element={<ScriptBankPage />} />
        <Route path="/writers" element={managers(<WritersPage />)} />
        <Route path="/settings" element={only(<SettingsPage />)} />
        <Route path="/log" element={only(<MasterLogPage />)} />
        <Route path="/whats-new" element={<WhatsNewPage />} />
        <Route path="*" element={<NotFound />} />
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
              <Route path="*" element={<Gate />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>
  </StrictMode>,
);


import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './hooks/useAuth';
import useDesktopBridge from './hooks/useDesktopBridge';
import useWebRecoveryWatchdog from './hooks/useWebRecoveryWatchdog';
import ProtectedRoute from './components/ProtectedRoute';
import DesktopEvents from './components/DesktopEvents';
import AutoUpdatePrompt from './components/AutoUpdatePrompt';
import Spinner from './components/Spinner';

import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import LandingPage from './pages/LandingPage';
import InvitePage from './pages/InvitePage';

// Inner component to handle loading state logic using the hook
const AppContent = () => {
  const { loading, user } = useAuth();

  useDesktopBridge({ uid: user?.uid });
  useWebRecoveryWatchdog();

  // Block the entire UI until Auth check is complete
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      {/* Listen for Electron Desktop commands globally */}
      <DesktopEvents />
      <AutoUpdatePrompt />
      
      <HashRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/invite/:teamId" element={<InvitePage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </HashRouter>
    </>
  );
};

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;

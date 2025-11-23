import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/ProtectedRoute';
import DesktopEvents from './components/DesktopEvents';
import Spinner from './components/Spinner';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import LandingPage from './pages/LandingPage';
import InvitePage from './pages/InvitePage';
// Inner component to handle loading state logic using the hook
const AppContent = () => {
    const { loading } = useAuth();
    // Block the entire UI until Auth check is complete
    if (loading) {
        return (_jsx("div", { className: "flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900", children: _jsx(Spinner, {}) }));
    }
    return (_jsxs(_Fragment, { children: [_jsx(DesktopEvents, {}), _jsx(HashRouter, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(LandingPage, {}) }), _jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/signup", element: _jsx(SignupPage, {}) }), _jsx(Route, { path: "/reset-password", element: _jsx(ResetPasswordPage, {}) }), _jsx(Route, { path: "/invite/:teamId", element: _jsx(InvitePage, {}) }), _jsx(Route, { path: "/dashboard", element: _jsx(ProtectedRoute, { children: _jsx(DashboardPage, {}) }) })] }) })] }));
};
function App() {
    return (_jsx(AuthProvider, { children: _jsx(AppContent, {}) }));
}
export default App;

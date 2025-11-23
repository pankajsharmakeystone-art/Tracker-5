import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { resetPassword } from '../services/auth';
const ResetPasswordPage = () => {
    const [email, setEmail] = useState('');
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [loading, setLoading] = useState(false);
    const handleResetPassword = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            await resetPassword(email);
            setMessage('Check your email for a password reset link.');
        }
        catch (err) {
            const authError = err;
            setError(authError.message);
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0", children: _jsx("div", { className: "w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700", children: _jsxs("div", { className: "p-6 space-y-4 md:space-y-6 sm:p-8", children: [_jsx("h1", { className: "text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white", children: "Reset Your Password" }), error && _jsx("p", { className: "text-sm font-light text-red-500 dark:text-red-400", children: error }), message && _jsx("p", { className: "text-sm font-light text-green-500 dark:text-green-400", children: message }), _jsxs("form", { className: "space-y-4 md:space-y-6", onSubmit: handleResetPassword, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "email", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Your email" }), _jsx("input", { type: "email", name: "email", id: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "name@company.com", required: true })] }), _jsx("button", { type: "submit", disabled: loading, className: "w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50", children: loading ? 'Sending...' : 'Send Reset Link' }), _jsxs("p", { className: "text-sm font-light text-gray-500 dark:text-gray-400", children: ["Remember your password? ", _jsx(Link, { to: "/login", className: "font-medium text-blue-600 hover:underline dark:text-blue-500", children: "Sign in" })] })] })] }) }) }));
};
export default ResetPasswordPage;

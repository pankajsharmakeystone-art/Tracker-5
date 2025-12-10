import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { resetPassword, verifyResetCode, applyResetPassword } from '../services/auth';
import { AuthError } from 'firebase/auth';

const ResetPasswordPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const location = useLocation();
    const navigate = useNavigate();

    const oobCode = useMemo(() => new URLSearchParams(location.search).get('oobCode') || '', [location.search]);
    const hasCode = Boolean(oobCode);

    useEffect(() => {
        if (!hasCode) return;
        setError(null);
        setMessage(null);
        setVerifying(true);
        verifyResetCode(oobCode)
            .then((emailFromCode) => {
                setVerifiedEmail(emailFromCode);
            })
            .catch((err) => {
                const authError = err as AuthError;
                setError(authError?.message || 'Invalid or expired reset link. Please request a new one.');
            })
            .finally(() => setVerifying(false));
    }, [hasCode, oobCode]);

    const handleResetPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            await resetPassword(email);
            setMessage('Check your email for a password reset link.');
        } catch (err) {
            const authError = err as AuthError;
            setError(authError.message);
        } finally {
            setLoading(false);
        }
    };

    const handleApplyNewPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setMessage(null);

        if (!oobCode) {
            setError('Reset code is missing. Request a new link.');
            return;
        }

        if (newPassword !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }

        try {
            setLoading(true);
            await applyResetPassword(oobCode, newPassword);
            setMessage('Password updated. You can now sign in.');
            // Clear fields and drop query params to avoid reuse errors.
            setNewPassword('');
            setConfirmPassword('');
            setVerifiedEmail(null);
            navigate('/login');
        } catch (err) {
            const authError = err as AuthError;
            setError(authError?.message || 'Could not update password. Request a new link.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
            <div className="w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6 space-y-4 md:space-y-6 sm:p-8">
                    <h1 className="text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                        {hasCode ? 'Choose a new password' : 'Reset Your Password'}
                    </h1>
                    {error && <p className="text-sm font-light text-red-500 dark:text-red-400">{error}</p>}
                    {message && <p className="text-sm font-light text-green-500 dark:text-green-400">{message}</p>}

                    {!hasCode && (
                        <form className="space-y-4 md:space-y-6" onSubmit={handleResetPassword}>
                            <div>
                                <label htmlFor="email" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Your email</label>
                                <input
                                    type="email"
                                    name="email"
                                    id="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                    placeholder="name@company.com"
                                    required
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                                {loading ? 'Sending...' : 'Send Reset Link'}
                            </button>
                            <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                                Remember your password? <Link to="/login"
                                                             className="font-medium text-blue-600 hover:underline dark:text-blue-500">Sign in</Link>
                            </p>
                        </form>
                    )}

                    {hasCode && (
                        <form className="space-y-4 md:space-y-6" onSubmit={handleApplyNewPassword}>
                            <div>
                                <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Account email</label>
                                <input
                                    type="email"
                                    value={verifiedEmail || 'Verifying...' }
                                    readOnly
                                    className="bg-gray-100 border border-gray-300 text-gray-700 sm:text-sm rounded-lg block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
                                />
                            </div>
                            <div>
                                <label htmlFor="new-password" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">New password</label>
                                <input
                                    type="password"
                                    id="new-password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                    placeholder="Enter a new password"
                                    required
                                    disabled={verifying}
                                />
                            </div>
                            <div>
                                <label htmlFor="confirm-password" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Confirm password</label>
                                <input
                                    type="password"
                                    id="confirm-password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                    placeholder="Re-enter the new password"
                                    required
                                    disabled={verifying}
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={loading || verifying}
                                className="w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                                {loading ? 'Updating...' : 'Update Password'}
                            </button>
                            <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                                Link expired? <button type="button" className="font-medium text-blue-600 hover:underline dark:text-blue-500" onClick={() => navigate('/reset-password')}>Request a new link</button>
                            </p>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ResetPasswordPage;
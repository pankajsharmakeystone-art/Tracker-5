
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signIn, signInWithGoogle } from '../services/auth';
import { AuthError } from 'firebase/auth';

const GoogleIcon = () => (
    <svg className="w-5 h-5 mr-2" aria-hidden="true" focusable="false" data-prefix="fab" data-icon="google" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512">
        <path fill="currentColor" d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 126 23.4 172.9 61.9l-69.5 69.5c-24.3-23.4-58.4-38.1-98.4-38.1-84.3 0-152.2 67.9-152.2 152.2s67.9 152.2 152.2 152.2c92.2 0 125.9-63.5 130.8-93.5H248V261.8h239.2z"></path>
    </svg>
);

const LoginPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();

    const handleEmailSignIn = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await signIn(email, password);
            navigate('/dashboard');
        } catch (err) {
            const authError = err as AuthError;
            const code = authError?.code || '';
            if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
                setError('Wrong email or password.');
            } else {
                setError(authError.message || 'Sign-in failed.');
            }
        } finally {
            setLoading(false);
        }
    };
    
    const handleGoogleSignIn = async () => {
        setLoading(true);
        setError(null);
        try {
            await signInWithGoogle();
            navigate('/dashboard');
        } catch (err) {
            const authError = err as AuthError;
            setError(authError.message || 'Sign-in failed.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
            <div className="w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6 space-y-4 md:space-y-6 sm:p-8">
                    <h1 className="text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                        Sign in to your account
                    </h1>
                    {error && <p className="text-sm font-light text-red-500 dark:text-red-400">{error}</p>}
                    <form className="space-y-4 md:space-y-6" onSubmit={handleEmailSignIn}>
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
                        <div>
                            <label htmlFor="password"
                                   className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Password</label>
                            <input
                                type="password"
                                name="password"
                                id="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                required
                            />
                        </div>
                        <div className="flex items-center justify-between">
                             <Link to="/"
                                  className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-500">Back to Home</Link>
                            <Link to="/reset-password"
                                  className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-500">Forgot password?</Link>
                        </div>
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                            {loading ? 'Signing In...' : 'Sign in'}
                        </button>
                        <div className="relative flex py-2 items-center">
                            <div className="flex-grow border-t border-gray-400"></div>
                            <span className="flex-shrink mx-4 text-gray-400">Or</span>
                            <div className="flex-grow border-t border-gray-400"></div>
                        </div>
                         <button
                            type="button"
                            onClick={handleGoogleSignIn}
                            disabled={loading}
                            className="w-full flex items-center justify-center text-gray-700 bg-white hover:bg-gray-100 border border-gray-300 focus:ring-4 focus:outline-none focus:ring-gray-200 font-medium rounded-lg text-sm px-5 py-2.5 dark:bg-gray-800 dark:text-white dark:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 disabled:opacity-50">
                            <GoogleIcon /> Sign in with Google
                        </button>
                        <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                            Need an admin account? <Link to="/signup"
                                                             className="font-medium text-blue-600 hover:underline dark:text-blue-500">Create Admin Account</Link>
                        </p>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default LoginPage;

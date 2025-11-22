
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signUp } from '../services/auth';
import { adminExists } from '../services/db';
import { AuthError } from 'firebase/auth';

const SignupPage: React.FC = () => {
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [isAdminPresent, setIsAdminPresent] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        const checkAdmin = async () => {
            const exists = await adminExists();
            setIsAdminPresent(exists);
            if (exists) {
                setError("An admin account already exists. Please contact your admin for an invitation to join a team.");
            }
        };
        checkAdmin();
    }, []);

    const handleSignUp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isAdminPresent) return;

        setLoading(true);
        setError(null);
        try {
            await signUp(email, password, displayName);
            navigate('/dashboard');
        } catch (err) {
            const authError = err as AuthError;
            setError(authError.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
            <div className="w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6 space-y-4 md:space-y-6 sm:p-8">
                    <h1 className="text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                        Create Admin Account
                    </h1>
                    {error && <p className="text-sm font-light text-red-500 dark:text-red-400">{error}</p>}
                    <form className="space-y-4 md:space-y-6" onSubmit={handleSignUp}>
                         <div>
                            <label htmlFor="displayName" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Your name</label>
                            <input
                                type="text"
                                name="displayName"
                                id="displayName"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white disabled:opacity-50"
                                placeholder="John Doe"
                                required
                                disabled={isAdminPresent}
                            />
                        </div>
                        <div>
                            <label htmlFor="email" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Your email</label>
                            <input
                                type="email"
                                name="email"
                                id="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white disabled:opacity-50"
                                placeholder="name@company.com"
                                required
                                disabled={isAdminPresent}
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
                                className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white disabled:opacity-50"
                                required
                                minLength={6}
                                disabled={isAdminPresent}
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading || isAdminPresent}
                            className="w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                            {loading ? 'Creating Account...' : 'Create account'}
                        </button>
                        <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                            Already have an account? <Link to="/login"
                                                             className="font-medium text-blue-600 hover:underline dark:text-blue-500">Login here</Link>
                        </p>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default SignupPage;

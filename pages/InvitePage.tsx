
import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { signUpWithInvite } from '../services/auth';
import { getTeamById } from '../services/db';
import type { Team } from '../types';
import { AuthError } from 'firebase/auth';

const InvitePage: React.FC = () => {
    const { teamId } = useParams<{ teamId: string }>();
    const navigate = useNavigate();

    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [team, setTeam] = useState<Team | null>(null);
    const [isValidating, setIsValidating] = useState(true);

    useEffect(() => {
        if (!teamId) {
            setError('No invitation code provided.');
            setIsValidating(false);
            return;
        }

        const validateInvite = async () => {
            try {
                const teamData = await getTeamById(teamId);
                if (teamData) {
                    setTeam(teamData);
                } else {
                    setError('This invitation link is invalid or has expired.');
                }
            } catch (err) {
                setError('Failed to validate invitation link.');
            } finally {
                setIsValidating(false);
            }
        };

        validateInvite();
    }, [teamId]);

    const handleSignUp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!teamId) return;

        setLoading(true);
        setError(null);
        try {
            await signUpWithInvite(email, password, displayName, teamId);
            navigate('/dashboard');
        } catch (err) {
            const authError = err as AuthError;
            setError(authError.message);
        } finally {
            setLoading(false);
        }
    };

    if (isValidating) {
        return (
            <div className="flex items-center justify-center min-h-screen text-white">
                Validating invitation...
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
            <div className="w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6 space-y-4 md:space-y-6 sm:p-8">
                    {team ? (
                        <>
                            <h1 className="text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                                Join Team: <span className="text-blue-500">{team.name}</span>
                            </h1>
                            <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                                Create an account to accept your invitation.
                            </p>
                        </>
                    ) : (
                        <h1 className="text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                            Invalid Invitation
                        </h1>
                    )}

                    {error && <p className="text-sm font-light text-red-500 dark:text-red-400">{error}</p>}
                    
                    {team && (
                        <form className="space-y-4 md:space-y-6" onSubmit={handleSignUp}>
                             <div>
                                <label htmlFor="displayName" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Your name</label>
                                <input
                                    type="text"
                                    name="displayName"
                                    id="displayName"
                                    value={displayName}
                                    onChange={(e) => setDisplayName(e.target.value)}
                                    className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                    placeholder="John Doe"
                                    required
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
                                    minLength={6}
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                                {loading ? 'Joining Team...' : 'Join Team'}
                            </button>
                             <p className="text-sm font-light text-gray-500 dark:text-gray-400">
                                Already have an account? <Link to="/login"
                                                                className="font-medium text-blue-600 hover:underline dark:text-blue-500">Login here</Link>
                            </p>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

export default InvitePage;

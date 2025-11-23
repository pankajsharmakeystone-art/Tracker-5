import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { signUpWithInvite } from '../services/auth';
import { getTeamById } from '../services/db';
const InvitePage = () => {
    const { teamId } = useParams();
    const navigate = useNavigate();
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [team, setTeam] = useState(null);
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
                }
                else {
                    setError('This invitation link is invalid or has expired.');
                }
            }
            catch (err) {
                setError('Failed to validate invitation link.');
            }
            finally {
                setIsValidating(false);
            }
        };
        validateInvite();
    }, [teamId]);
    const handleSignUp = async (e) => {
        e.preventDefault();
        if (!teamId)
            return;
        setLoading(true);
        setError(null);
        try {
            await signUpWithInvite(email, password, displayName, teamId);
            navigate('/dashboard');
        }
        catch (err) {
            const authError = err;
            setError(authError.message);
        }
        finally {
            setLoading(false);
        }
    };
    if (isValidating) {
        return (_jsx("div", { className: "flex items-center justify-center min-h-screen text-white", children: "Validating invitation..." }));
    }
    return (_jsx("div", { className: "flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0", children: _jsx("div", { className: "w-full bg-white rounded-lg shadow-xl dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700", children: _jsxs("div", { className: "p-6 space-y-4 md:space-y-6 sm:p-8", children: [team ? (_jsxs(_Fragment, { children: [_jsxs("h1", { className: "text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white", children: ["Join Team: ", _jsx("span", { className: "text-blue-500", children: team.name })] }), _jsx("p", { className: "text-sm font-light text-gray-500 dark:text-gray-400", children: "Create an account to accept your invitation." })] })) : (_jsx("h1", { className: "text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white", children: "Invalid Invitation" })), error && _jsx("p", { className: "text-sm font-light text-red-500 dark:text-red-400", children: error }), team && (_jsxs("form", { className: "space-y-4 md:space-y-6", onSubmit: handleSignUp, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "displayName", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Your name" }), _jsx("input", { type: "text", name: "displayName", id: "displayName", value: displayName, onChange: (e) => setDisplayName(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "John Doe", required: true })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "email", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Your email" }), _jsx("input", { type: "email", name: "email", id: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "name@company.com", required: true })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "password", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Password" }), _jsx("input", { type: "password", name: "password", id: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", required: true, minLength: 6 })] }), _jsx("button", { type: "submit", disabled: loading, className: "w-full text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50", children: loading ? 'Joining Team...' : 'Join Team' }), _jsxs("p", { className: "text-sm font-light text-gray-500 dark:text-gray-400", children: ["Already have an account? ", _jsx(Link, { to: "/login", className: "font-medium text-blue-600 hover:underline dark:text-blue-500", children: "Login here" })] })] }))] }) }) }));
};
export default InvitePage;

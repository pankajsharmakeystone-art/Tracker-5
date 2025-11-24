
import React from 'react';
import { Link } from 'react-router-dom';

const LandingPage: React.FC = () => {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center bg-gray-50 dark:bg-gray-900">
            <main className="max-w-2xl">
                <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold text-gray-900 dark:text-white">
                    Welcome to Your Team Hub
                </h1>
                <p className="mt-4 text-lg sm:text-xl text-gray-600 dark:text-gray-300">
                    <span className="bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded">
                        A complete solution for managing your teams with role-based access.
                    </span>
                </p>
                <div className="mt-8 flex flex-col sm:flex-row justify-center gap-4">
                    <Link
                        to="/signup"
                        className="inline-flex items-center justify-center px-6 py-3 text-base font-medium text-white bg-blue-600 border border-transparent rounded-md shadow-sm hover:bg-blue-700"
                    >
                        Get Started (Create Admin)
                    </Link>
                    <Link
                        to="/login"
                        className="inline-flex items-center justify-center px-6 py-3 text-base font-medium text-blue-700 bg-blue-100 border border-transparent rounded-md hover:bg-blue-200 dark:text-white dark:bg-gray-700 dark:hover:bg-gray-600"
                    >
                        Sign In
                    </Link>
                    <a
                        href="https://github.com/pankajsharmakeystone-art/Tracker-5/releases/latest"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center px-6 py-3 text-base font-medium text-white bg-green-600 border border-transparent rounded-md shadow-sm hover:bg-green-700"
                    >
                        Download Desktop App
                    </a>
                </div>
            </main>
        </div>
    );
};

export default LandingPage;

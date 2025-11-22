
import React from 'react';

interface ManualBreakTimeoutModalProps {
    isOpen: boolean;
    timeoutMinutes: number;
    onRemoveBreak: () => void;
    onContinueBreak: () => void;
}

const ManualBreakTimeoutModal: React.FC<ManualBreakTimeoutModalProps> = ({ isOpen, timeoutMinutes, onRemoveBreak, onContinueBreak }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-80 p-4" aria-modal="true" role="dialog">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl max-w-md w-full p-6 border-2 border-red-500">
                <div className="flex items-center justify-center mb-4 text-red-600 dark:text-red-400">
                    <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <h2 className="text-xl font-bold text-center text-gray-900 dark:text-white mb-2">Break Time Limit Exceeded</h2>
                <p className="text-center text-gray-600 dark:text-gray-300 mb-6">
                    You have been on manual break for more than <span className="font-bold">{timeoutMinutes} minutes</span>.
                </p>
                <div className="flex flex-col gap-3">
                    <button 
                        onClick={onRemoveBreak}
                        className="w-full px-4 py-3 text-base font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700 shadow-md transition-colors"
                    >
                        Remove Break & Return Online
                    </button>
                    <button 
                        onClick={onContinueBreak}
                        className="w-full px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                    >
                        Continue Break
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ManualBreakTimeoutModal;

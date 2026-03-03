
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { streamAppActivitySummaries, streamGlobalAdminSettings } from '../services/db';
import type { AppActivitySummary, AppCategory, AppCategoryRule } from '../types';
import Spinner from './Spinner';

interface Props {
    teamId?: string;
}

type AgentSortKey = 'agent' | 'total' | 'productive' | 'development' | 'communication' | 'social' | 'entertainment' | 'other';
type TimelineSortKey = 'time' | 'application' | 'title' | 'category' | 'duration';

const CATEGORY_COLORS: Record<AppCategory, string> = {
    productive: '#22c55e',
    development: '#3b82f6',
    communication: '#f59e0b',
    design: '#a855f7',
    social: '#ec4899',
    entertainment: '#ef4444',
    uncategorized: '#6b7280',
};

const CATEGORY_LABELS: Record<AppCategory, string> = {
    productive: 'Productive',
    development: 'Development',
    communication: 'Communication',
    design: 'Design',
    social: 'Social',
    entertainment: 'Entertainment',
    uncategorized: 'Uncategorized',
};

const formatDuration = (totalSeconds: number): string => {
    if (totalSeconds < 0) totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const formatPercent = (part: number, total: number): string => {
    if (total === 0) return '0%';
    const pct = (part / total) * 100;
    if (pct > 0 && pct < 1) return '<1%';
    return `${Math.round(pct)}%`;
};

// Mirrors the classification logic in electron/appTracker.js
const BUILTIN_RULES: AppCategoryRule[] = [
    { type: 'app', pattern: 'code', category: 'development' },
    { type: 'app', pattern: 'visual studio', category: 'development' },
    { type: 'app', pattern: 'intellij', category: 'development' },
    { type: 'app', pattern: 'terminal', category: 'development' },
    { type: 'app', pattern: 'powershell', category: 'development' },
    { type: 'app', pattern: 'git', category: 'development' },
    { type: 'app', pattern: 'postman', category: 'development' },
    { type: 'app', pattern: 'docker', category: 'development' },
    { type: 'title', pattern: 'github', category: 'development' },
    { type: 'title', pattern: 'gitlab', category: 'development' },
    { type: 'title', pattern: 'stack overflow', category: 'development' },
    { type: 'app', pattern: 'winword', category: 'productive' },
    { type: 'app', pattern: 'excel', category: 'productive' },
    { type: 'app', pattern: 'powerpnt', category: 'productive' },
    { type: 'title', pattern: 'google docs', category: 'productive' },
    { type: 'title', pattern: 'google sheets', category: 'productive' },
    { type: 'title', pattern: 'notion', category: 'productive' },
    { type: 'title', pattern: 'jira', category: 'productive' },
    { type: 'title', pattern: 'trello', category: 'productive' },
    { type: 'title', pattern: 'confluence', category: 'productive' },
    { type: 'app', pattern: 'slack', category: 'communication' },
    { type: 'app', pattern: 'teams', category: 'communication' },
    { type: 'app', pattern: 'zoom', category: 'communication' },
    { type: 'app', pattern: 'outlook', category: 'communication' },
    { type: 'title', pattern: 'gmail', category: 'communication' },
    { type: 'title', pattern: 'google meet', category: 'communication' },
    { type: 'title', pattern: 'whatsapp', category: 'communication' },
    { type: 'title', pattern: 'facebook', category: 'social' },
    { type: 'title', pattern: 'twitter', category: 'social' },
    { type: 'title', pattern: 'instagram', category: 'social' },
    { type: 'title', pattern: 'linkedin', category: 'social' },
    { type: 'title', pattern: 'reddit', category: 'social' },
    { type: 'title', pattern: 'tiktok', category: 'social' },
    { type: 'title', pattern: 'youtube', category: 'entertainment' },
    { type: 'title', pattern: 'netflix', category: 'entertainment' },
    { type: 'app', pattern: 'spotify', category: 'entertainment' },
    { type: 'app', pattern: 'steam', category: 'entertainment' },
    { type: 'app', pattern: 'figma', category: 'design' },
    { type: 'title', pattern: 'figma', category: 'design' },
    { type: 'title', pattern: 'canva', category: 'design' },
];

function classifyEntry(appName: string, title: string, adminRules: AppCategoryRule[]): AppCategory {
    const appL = (appName || '').toLowerCase();
    const titleL = (title || '').toLowerCase();
    for (const rule of [...adminRules, ...BUILTIN_RULES]) {
        const target = rule.type === 'app' ? appL : titleL;
        if (target.includes(rule.pattern.toLowerCase())) return rule.category as AppCategory;
    }
    return 'uncategorized';
}

const buildTopAppsFromEntries = (entries: Array<{ app: string; category: string; durationSeconds: number }>) => {
    const appTotals: Record<string, { app: string; seconds: number; categorySeconds: Record<string, number> }> = {};
    for (const e of entries || []) {
        const app = e?.app;
        if (!app) continue;
        const dur = Number(e?.durationSeconds) || 0;
        if (!appTotals[app]) {
            appTotals[app] = { app, seconds: 0, categorySeconds: {} };
        }
        appTotals[app].seconds += dur;
        const category = e?.category || 'uncategorized';
        appTotals[app].categorySeconds[category] = (appTotals[app].categorySeconds[category] || 0) + dur;
    }

    return Object.values(appTotals)
        .map((item) => {
            const rankedCats = Object.entries(item.categorySeconds).sort((a, b) => (b[1] || 0) - (a[1] || 0));
            const dominantCategory = (rankedCats[0]?.[0] || 'uncategorized') as AppCategory;
            return {
                app: item.app,
                category: dominantCategory,
                seconds: item.seconds
            };
        })
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 20);
};

const AppTrackingReport: React.FC<Props> = ({ teamId }) => {
    const [summaries, setSummaries] = useState<AppActivitySummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedUser, setSelectedUser] = useState<string | null>(null);
    const [userNames, setUserNames] = useState<Record<string, string>>({});
    const [adminRules, setAdminRules] = useState<AppCategoryRule[]>([]);
    const [recategorizing, setRecategorizing] = useState(false);
    const [agentSearch, setAgentSearch] = useState('');
    const [agentSortKey, setAgentSortKey] = useState<AgentSortKey>('total');
    const [agentSortDir, setAgentSortDir] = useState<'asc' | 'desc'>('desc');
    const [timelineSortKey, setTimelineSortKey] = useState<TimelineSortKey>('time');
    const [timelineSortDir, setTimelineSortDir] = useState<'asc' | 'desc'>('asc');

    // Fetch user display names once on mount
    useEffect(() => {
        getDocs(collection(db, 'users')).then(snap => {
            const map: Record<string, string> = {};
            snap.docs.forEach(d => {
                const data = d.data();
                map[d.id] = data.displayName || data.name || data.email || d.id;
            });
            setUserNames(map);
        }).catch(() => { /* best-effort */ });
    }, []);

    // Stream admin settings to get current category rules
    useEffect(() => {
        const unsub = streamGlobalAdminSettings((settings) => {
            setAdminRules(settings?.appCategoryRules ?? []);
        });
        return () => unsub();
    }, []);

    // Re-apply current category rules to all stored entries for this date
    const handleRecategorize = async () => {
        if (!summaries.length) return;
        const confirmed = window.confirm(
            `Re-apply current category rules to ${summaries.length} agent record(s) for ${selectedDate}?\n\nThis will recompute categories, top apps, and totals based on your current Admin Settings rules.`
        );
        if (!confirmed) return;
        setRecategorizing(true);
        try {
            for (const summary of summaries) {
                const entries = (summary.entries || []).map(e => ({
                    ...e,
                    category: classifyEntry(e.app, e.title, adminRules),
                }));
                const byCategory: Record<string, number> = {};
                let total = 0;
                for (const e of entries) {
                    const dur = e.durationSeconds || 0;
                    total += dur;
                    byCategory[e.category] = (byCategory[e.category] || 0) + dur;
                }
                const topApps = buildTopAppsFromEntries(entries);
                const docId = `${summary.userId}_${selectedDate}`;
                await setDoc(doc(db, 'appActivity', docId), {
                    ...summary,
                    entries,
                    byCategory,
                    topApps,
                    totalTrackedSeconds: total,
                });
            }
            alert('Re-categorization complete! The report will refresh automatically.');
        } catch (err: any) {
            alert('Re-categorization failed: ' + (err?.message || err));
        } finally {
            setRecategorizing(false);
        }
    };

    const [selectedDate, setSelectedDate] = useState(() => {
        const d = new Date();
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    });

    useEffect(() => {
        setLoading(true);
        const unsub = streamAppActivitySummaries(selectedDate, (data) => {
            setSummaries(data);
            setLoading(false);
        }, teamId);
        return () => unsub();
    }, [selectedDate, teamId]);

    // Aggregate totals across all users
    const aggregated = useMemo(() => {
        const byCategory: Record<string, number> = {};
        const byUser: Record<string, { userId: string; totalSeconds: number; byCategory: Record<string, number> }> = {};
        const topAppTotals: Record<string, { app: string; seconds: number; categorySeconds: Record<string, number> }> = {};
        let totalSeconds = 0;

        for (const summary of summaries) {
            totalSeconds += summary.totalTrackedSeconds || 0;

            // Per category
            if (summary.byCategory) {
                for (const [cat, secs] of Object.entries(summary.byCategory)) {
                    byCategory[cat] = (byCategory[cat] || 0) + (secs as number);
                }
            }

            // Per user
            if (!byUser[summary.userId]) {
                byUser[summary.userId] = { userId: summary.userId, totalSeconds: 0, byCategory: {} };
            }
            byUser[summary.userId].totalSeconds += summary.totalTrackedSeconds || 0;
            if (summary.byCategory) {
                for (const [cat, secs] of Object.entries(summary.byCategory)) {
                    byUser[summary.userId].byCategory[cat] = (byUser[summary.userId].byCategory[cat] || 0) + (secs as number);
                }
            }

            // Top apps
            if (Array.isArray(summary.entries) && summary.entries.length > 0) {
                for (const entry of summary.entries) {
                    const app = entry.app;
                    if (!app) continue;
                    const dur = Number(entry.durationSeconds) || 0;
                    if (!topAppTotals[app]) {
                        topAppTotals[app] = { app, seconds: 0, categorySeconds: {} };
                    }
                    topAppTotals[app].seconds += dur;
                    const category = entry.category || 'uncategorized';
                    topAppTotals[app].categorySeconds[category] = (topAppTotals[app].categorySeconds[category] || 0) + dur;
                }
            } else if (summary.topApps) {
                // Backward compatibility fallback for old docs without entries.
                for (const app of summary.topApps) {
                    if (!topAppTotals[app.app]) {
                        topAppTotals[app.app] = { app: app.app, seconds: 0, categorySeconds: {} };
                    }
                    topAppTotals[app.app].seconds += Number(app.seconds) || 0;
                    const category = (app.category || 'uncategorized') as string;
                    topAppTotals[app.app].categorySeconds[category] = (topAppTotals[app.app].categorySeconds[category] || 0) + (Number(app.seconds) || 0);
                }
            }
        }

        const topApps = Object.values(topAppTotals)
            .map((item) => {
                const rankedCats = Object.entries(item.categorySeconds).sort((a, b) => (b[1] || 0) - (a[1] || 0));
                const dominantCategory = (rankedCats[0]?.[0] || 'uncategorized') as AppCategory;
                return { app: item.app, category: dominantCategory, seconds: item.seconds };
            })
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 15);

        return {
            totalSeconds,
            byCategory,
            byUser: Object.values(byUser),
            topApps,
        };
    }, [summaries]);

    // Selected user detail
    const userDetail = useMemo(() => {
        if (!selectedUser) return null;
        return summaries.find(s => s.userId === selectedUser) || null;
    }, [selectedUser, summaries]);

    const handleTimelineSort = (field: TimelineSortKey) => {
        if (timelineSortKey === field) {
            setTimelineSortDir((prev) => prev === 'asc' ? 'desc' : 'asc');
            return;
        }
        setTimelineSortKey(field);
        setTimelineSortDir(field === 'time' ? 'asc' : 'desc');
    };

    const getTimelineSortIndicator = (field: TimelineSortKey) => {
        if (timelineSortKey !== field) return '';
        return timelineSortDir === 'asc' ? ' ↑' : ' ↓';
    };

    const sortedTimelineEntries = useMemo(() => {
        if (!userDetail?.entries || !Array.isArray(userDetail.entries)) return [];
        const rows = [...userDetail.entries];
        rows.sort((a, b) => {
            let cmp = 0;
            switch (timelineSortKey) {
                case 'time':
                    cmp = (Number(a.startTime) || 0) - (Number(b.startTime) || 0);
                    break;
                case 'application':
                    cmp = String(a.app || '').localeCompare(String(b.app || ''), undefined, { sensitivity: 'base' });
                    break;
                case 'title':
                    cmp = String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
                    break;
                case 'category':
                    cmp = String(a.category || '').localeCompare(String(b.category || ''), undefined, { sensitivity: 'base' });
                    break;
                case 'duration':
                    cmp = (Number(a.durationSeconds) || 0) - (Number(b.durationSeconds) || 0);
                    break;
                default:
                    cmp = 0;
                    break;
            }
            return timelineSortDir === 'asc' ? cmp : -cmp;
        });
        return rows;
    }, [userDetail, timelineSortKey, timelineSortDir]);

    const productiveSeconds = aggregated.byCategory.productive || 0;
    const developmentSeconds = aggregated.byCategory.development || 0;
    const communicationSeconds = aggregated.byCategory.communication || 0;
    const socialSeconds = aggregated.byCategory.social || 0;
    const entertainmentSeconds = aggregated.byCategory.entertainment || 0;
    const otherSeconds = (aggregated.byCategory.design || 0) + (aggregated.byCategory.uncategorized || 0);

    const getUserMetricSeconds = (user: { byCategory: Record<string, number>; totalSeconds: number }, key: AgentSortKey): number => {
        switch (key) {
            case 'total': return user.totalSeconds || 0;
            case 'productive': return user.byCategory.productive || 0;
            case 'development': return user.byCategory.development || 0;
            case 'communication': return user.byCategory.communication || 0;
            case 'social': return user.byCategory.social || 0;
            case 'entertainment': return user.byCategory.entertainment || 0;
            case 'other': return (user.byCategory.design || 0) + (user.byCategory.uncategorized || 0);
            default: return user.totalSeconds || 0;
        }
    };

    const handleAgentSort = (field: AgentSortKey) => {
        if (agentSortKey === field) {
            setAgentSortDir((prev) => prev === 'asc' ? 'desc' : 'asc');
            return;
        }
        setAgentSortKey(field);
        setAgentSortDir(field === 'agent' ? 'asc' : 'desc');
    };

    const getAgentSortIndicator = (field: AgentSortKey) => {
        if (agentSortKey !== field) return '';
        return agentSortDir === 'asc' ? ' ↑' : ' ↓';
    };

    const filteredSortedUsers = useMemo(() => {
        const q = agentSearch.trim().toLowerCase();
        const rows = aggregated.byUser.filter((user) => {
            const display = (userNames[user.userId] || user.userId || '').toLowerCase();
            if (q && !display.includes(q)) return false;
            return true;
        });

        rows.sort((a, b) => {
            let cmp = 0;
            if (agentSortKey === 'agent') {
                const aName = userNames[a.userId] || a.userId;
                const bName = userNames[b.userId] || b.userId;
                cmp = aName.localeCompare(bName);
            } else {
                cmp = getUserMetricSeconds(a, agentSortKey) - getUserMetricSeconds(b, agentSortKey);
            }
            return agentSortDir === 'asc' ? cmp : -cmp;
        });

        return rows;
    }, [aggregated.byUser, userNames, agentSearch, agentSortKey, agentSortDir]);

    if (loading) {
        return <div className="flex justify-center items-center p-8"><Spinner /></div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">App &amp; Website Tracking</h3>
                <div className="flex items-center gap-2">
                    {summaries.length > 0 && (
                        <button
                            onClick={handleRecategorize}
                            disabled={recategorizing}
                            className="text-sm px-3 py-2 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700 disabled:opacity-50 transition-colors"
                        >
                            {recategorizing ? 'Re-categorizing...' : '↻ Re-categorize'}
                        </button>
                    )}
                    <input
                        type="date"
                        value={selectedDate}
                        onChange={(e) => setSelectedDate(e.target.value)}
                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                </div>
            </div>

            {summaries.length === 0 ? (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <p className="text-lg mb-2">No tracking data for this date</p>
                    <p className="text-sm">Tracking data will appear here once agents clock out with app tracking enabled.</p>
                </div>
            ) : (
                <>
                    {/* Summary Cards */}
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Total Tracked</p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatDuration(aggregated.totalSeconds)}</p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Users Tracked</p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-white">{summaries.length}</p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Productive</p>
                            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                                {formatPercent(productiveSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Development</p>
                            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                                {formatPercent(developmentSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Communication</p>
                            <p className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                                {formatPercent(communicationSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Social</p>
                            <p className="text-2xl font-bold text-pink-600 dark:text-pink-400">
                                {formatPercent(socialSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Entertainment</p>
                            <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                                {formatPercent(entertainmentSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">Other</p>
                            <p className="text-2xl font-bold text-gray-500 dark:text-gray-400">
                                {formatPercent(otherSeconds, aggregated.totalSeconds)}
                            </p>
                        </div>
                    </div>

                    {/* Category Breakdown Bar */}
                    <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Category Breakdown</h4>
                        <div className="h-6 rounded-full overflow-hidden flex bg-gray-200 dark:bg-gray-700">
                            {Object.entries(aggregated.byCategory)
                                .filter(([, secs]) => secs > 0)
                                .sort(([, a], [, b]) => b - a)
                                .map(([cat, secs]) => (
                                    <div
                                        key={cat}
                                        title={`${CATEGORY_LABELS[cat as AppCategory] || cat}: ${formatDuration(secs)} (${formatPercent(secs, aggregated.totalSeconds)})`}
                                        style={{
                                            width: `${(secs / aggregated.totalSeconds) * 100}%`,
                                            backgroundColor: CATEGORY_COLORS[cat as AppCategory] || '#6b7280',
                                            minWidth: '2px'
                                        }}
                                        className="h-full transition-all"
                                    />
                                ))
                            }
                        </div>
                        <div className="flex flex-wrap gap-3 mt-3">
                            {Object.entries(aggregated.byCategory)
                                .filter(([, secs]) => secs > 0)
                                .sort(([, a], [, b]) => b - a)
                                .map(([cat, secs]) => (
                                    <div key={cat} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                                        <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: CATEGORY_COLORS[cat as AppCategory] || '#6b7280' }} />
                                        {CATEGORY_LABELS[cat as AppCategory] || cat}: {formatDuration(secs)}
                                    </div>
                                ))
                            }
                        </div>
                    </div>

                    {/* Top Apps */}
                    <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Top Applications</h4>
                        <div className="space-y-1">
                            {aggregated.topApps.map((app, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                    <span className="text-sm text-gray-500 dark:text-gray-400 w-6 text-right">{idx + 1}.</span>
                                    <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{app.app}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Per-User Table */}
                    <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Per-Agent Breakdown</h4>
                        <div className="mb-3">
                            <input
                                type="text"
                                value={agentSearch}
                                onChange={(e) => setAgentSearch(e.target.value)}
                                placeholder="Search agent..."
                                className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 w-full md:max-w-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                            />
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="text-xs text-gray-500 dark:text-gray-400 uppercase border-b dark:border-gray-700">
                                    <tr>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('agent')}>Agent{getAgentSortIndicator('agent')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('total')}>Total{getAgentSortIndicator('total')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('productive')}>Productive{getAgentSortIndicator('productive')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('development')}>Development{getAgentSortIndicator('development')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('communication')}>Communication{getAgentSortIndicator('communication')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('social')}>Social{getAgentSortIndicator('social')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('entertainment')}>Entertainment{getAgentSortIndicator('entertainment')}</th>
                                        <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleAgentSort('other')}>Other{getAgentSortIndicator('other')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredSortedUsers.map((user) => (
                                        <tr
                                            key={user.userId}
                                            onClick={() => setSelectedUser(selectedUser === user.userId ? null : user.userId)}
                                            className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                                        >
                                            <td className="py-2 px-3 font-medium text-gray-900 dark:text-white">{userNames[user.userId] || user.userId}</td>
                                            <td className="py-2 px-3">{formatDuration(user.totalSeconds)}</td>
                                            <td className="py-2 px-3 text-green-600">{formatDuration(user.byCategory.productive || 0)}</td>
                                            <td className="py-2 px-3 text-blue-600">{formatDuration(user.byCategory.development || 0)}</td>
                                            <td className="py-2 px-3 text-yellow-600">{formatDuration(user.byCategory.communication || 0)}</td>
                                            <td className="py-2 px-3 text-pink-600">{formatDuration(user.byCategory.social || 0)}</td>
                                            <td className="py-2 px-3 text-red-600">{formatDuration(user.byCategory.entertainment || 0)}</td>
                                            <td className="py-2 px-3 text-gray-500">
                                                {formatDuration((user.byCategory.design || 0) + (user.byCategory.uncategorized || 0))}
                                            </td>
                                        </tr>
                                    ))}
                                    {filteredSortedUsers.length === 0 && (
                                        <tr>
                                            <td colSpan={8} className="py-4 px-3 text-center text-gray-500 dark:text-gray-400">
                                                No agents match the current search.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* User Detail Timeline */}
                    {userDetail && (
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm">
                            <div className="flex justify-between items-center mb-3">
                                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                    Activity Timeline — {userNames[userDetail.userId] || userDetail.userId}
                                </h4>
                                <button
                                    onClick={() => setSelectedUser(null)}
                                    className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                                >
                                    Close
                                </button>
                            </div>
                            <div className="max-h-96 overflow-y-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="text-xs text-gray-500 dark:text-gray-400 uppercase border-b dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800">
                                        <tr>
                                            <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleTimelineSort('time')}>Time{getTimelineSortIndicator('time')}</th>
                                            <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleTimelineSort('application')}>Application{getTimelineSortIndicator('application')}</th>
                                            <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleTimelineSort('title')}>Title/Page{getTimelineSortIndicator('title')}</th>
                                            <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleTimelineSort('category')}>Category{getTimelineSortIndicator('category')}</th>
                                            <th className="py-2 px-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none" onClick={() => handleTimelineSort('duration')}>Duration{getTimelineSortIndicator('duration')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sortedTimelineEntries.map((entry, idx) => {
                                            const start = new Date(entry.startTime);
                                            const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                            return (
                                                <tr key={idx} className="border-b dark:border-gray-700">
                                                    <td className="py-1.5 px-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{timeStr}</td>
                                                    <td className="py-1.5 px-3 font-medium text-gray-900 dark:text-white">{entry.app}</td>
                                                    <td className="py-1.5 px-3 text-gray-600 dark:text-gray-400 truncate max-w-xs">{entry.title}</td>
                                                    <td className="py-1.5 px-3">
                                                        <span
                                                            className="text-xs px-1.5 py-0.5 rounded-full text-white"
                                                            style={{ backgroundColor: CATEGORY_COLORS[entry.category as AppCategory] || '#6b7280' }}
                                                        >
                                                            {CATEGORY_LABELS[entry.category as AppCategory] || entry.category}
                                                        </span>
                                                    </td>
                                                    <td className="py-1.5 px-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                                        {formatDuration(entry.durationSeconds)}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default AppTrackingReport;

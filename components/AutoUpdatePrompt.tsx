import React, { useEffect, useMemo, useState } from 'react';

type UpdateStage = 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateState {
  stage: UpdateStage;
  version?: string;
  percent?: number;
  message?: string;
}

const clampPercent = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
};

const AutoUpdatePrompt: React.FC = () => {
  const [state, setState] = useState<UpdateState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!window.desktopAPI?.onAutoUpdateStatus) return;

    const unsubscribe = window.desktopAPI.onAutoUpdateStatus((payload: any) => {
      const event = payload?.event;
      if (!event) return;

      switch (event) {
        case 'available':
          setState({ stage: 'available', version: payload?.version });
          setVisible(true);
          break;
        case 'downloading':
          setState((prev) => ({
            stage: 'downloading',
            version: prev?.version || payload?.version,
            percent: payload?.percent ?? prev?.percent,
          }));
          setVisible(true);
          break;
        case 'downloaded':
          setState({ stage: 'downloaded', version: payload?.version });
          setVisible(true);
          break;
        case 'error':
          setState({ stage: 'error', message: payload?.message });
          setVisible(true);
          break;
        case 'up-to-date':
          setState(null);
          setVisible(false);
          break;
        default:
          break;
      }
    });

    // Kick off an immediate check when the component mounts
    window.desktopAPI.requestImmediateUpdateCheck?.().catch(() => undefined);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  const progress = useMemo(() => {
    if (state?.stage !== 'downloading') return null;
    return clampPercent(state.percent);
  }, [state]);

  if (!visible || !state) return null;

  const handleDismiss = () => setVisible(false);
  const handleInstall = () => window.desktopAPI?.installPendingUpdate?.();
  const handleRetry = () => window.desktopAPI?.requestImmediateUpdateCheck?.();

  let title = '';
  let description = '';

  switch (state.stage) {
    case 'available':
      title = 'Update available';
      description = state.version
        ? `Version ${state.version} is downloading in the background.`
        : 'A new version is downloading in the background.';
      break;
    case 'downloading':
      title = 'Downloading update';
      description = 'We will install the update as soon as it finishes downloading.';
      break;
    case 'downloaded':
      title = 'Update ready to install';
      description = 'Restart Tracker 5 Desktop to finish installing the latest version.';
      break;
    case 'error':
      title = 'Update failed';
      description = state.message || 'Something went wrong while downloading the update.';
      break;
    default:
      break;
  }

  const showPrimary = state.stage === 'downloaded' || state.stage === 'error';
  const primaryLabel = state.stage === 'downloaded' ? 'Restart & Install' : 'Retry';
  const primaryAction = state.stage === 'downloaded' ? handleInstall : handleRetry;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80">
      <div className="rounded-xl border border-slate-700 bg-slate-900/95 p-4 text-white shadow-2xl backdrop-blur">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs text-slate-200">{description}</p>

        {progress !== null && (
          <div className="mt-3 h-2 w-full rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-blue-400 transition-all"
              style={{ width: `${progress}%` }}
            />
            <p className="mt-1 text-right text-[11px] text-slate-300">{progress}%</p>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-800"
            onClick={handleDismiss}
          >
            Later
          </button>
          {showPrimary && (
            <button
              type="button"
              className="rounded-md bg-blue-500 px-3 py-1 text-xs font-semibold text-white transition hover:bg-blue-400"
              onClick={primaryAction}
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AutoUpdatePrompt;

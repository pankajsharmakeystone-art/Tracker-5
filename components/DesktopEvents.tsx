
import React, { useEffect, useRef } from 'react';
import { startDesktopRecording, stopDesktopRecording } from '../desktop/recorder';

interface DesktopSource {
  id: string;
  name: string;
}

const DesktopEvents: React.FC = () => {
  const listenersAttached = useRef(false);

  useEffect(() => {
    if (!window.desktopAPI || listenersAttached.current) return;

    console.log("DesktopEvents: Attaching IPC listeners...");

    // Listener for Start Recording Command from Main Process
    window.desktopAPI.onCommandStartRecording(async ({ uid }: { uid: string }) => {
      console.log("IPC Command: Start Recording for UID:", uid);
      
      try {
        const result = await window.desktopAPI!.requestScreenSources();
        
        if (!result?.success) {
          console.error("Error getting sources:", result?.error);
          return;
        }
        
        const sources = (result.sources || []) as DesktopSource[];
        if (!sources || sources.length === 0) {
          console.error("No screen sources available");
          return;
        }

        const screenSources = sources.filter((src: DesktopSource) => src.id.startsWith('screen') || /screen/i.test(src.name));
        const targets = screenSources.length > 0 ? screenSources : [sources[0]];

        console.log("Starting recording for displays:", targets.map((s: DesktopSource) => `${s.name} (${s.id})`).join(', '));

        await startDesktopRecording(
          targets.map((s: DesktopSource) => s.id),
          targets.map((s: DesktopSource) => s.name),
          result.resolution
        );
      } catch (e) {
        console.error("Failed to handle start recording command", e);
      }
    });

    // Listener for Stop Recording Command from Main Process
    window.desktopAPI.onCommandStopRecording(() => {
      console.log("IPC Command: Stop Recording");
      stopDesktopRecording();
    });

    listenersAttached.current = true;
  }, []);

  // Ensure recordings are stopped and flushed if the renderer is about to unload (app quit/restart).
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        stopDesktopRecording();
      } catch (err) {
        console.warn('Failed to stop recorder during unload', err);
      }

      try {
        window.desktopAPI?.stopRecording?.({ reason: 'renderer-unload' });
      } catch (err) {
        console.warn('Failed to notify desktop about unload', err);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  return null; // This component does not render anything visually
};

export default DesktopEvents;
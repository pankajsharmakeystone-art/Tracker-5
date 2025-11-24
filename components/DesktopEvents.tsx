
import React, { useEffect, useRef } from 'react';
import { startDesktopRecording, stopDesktopRecording } from '../desktop/recorder';

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
        
        const sources = result.sources;
        if (!sources || sources.length === 0) {
          console.error("No screen sources available");
          return;
        }

        const screenSources = sources.filter((src) => src.id.startsWith('screen') || /screen/i.test(src.name));
        const targets = screenSources.length > 0 ? screenSources : [sources[0]];

        console.log("Starting recording for displays:", targets.map((s) => `${s.name} (${s.id})`).join(', '));

        await startDesktopRecording(
          targets.map((s) => s.id),
          targets.map((s) => s.name),
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

  return null; // This component does not render anything visually
};

export default DesktopEvents;
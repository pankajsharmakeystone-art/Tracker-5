
import React, { useEffect, useRef } from 'react';
import { signOut } from 'firebase/auth';
import { startDesktopRecording, stopDesktopRecording } from '../desktop/recorder';
import { auth } from '../services/firebase';

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

        // Capture all actual screens (filter out windows/virtuals by id/name) so multi-monitor setups are recorded.
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

    // Listener for forced sign-out events from the desktop main process.
    // Without this, the renderer can remain authenticated, preventing the desktop bridge
    // from re-registering in the same app session after a force logout.
    window.desktopAPI.onSignedOut?.(async ({ reason }: { reason?: string } = {}) => {
      console.log("IPC Event: Signed Out", reason || '');
      try {
        await signOut(auth);
      } catch (e) {
        console.error("Failed to sign out renderer after desktop sign-out", e);
      }
    });

    listenersAttached.current = true;
  }, []);

  // Recording now lives in a background window; do not stop on renderer unload.

  return null; // This component does not render anything visually
};

export default DesktopEvents;

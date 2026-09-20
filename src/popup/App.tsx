import { useEffect, useState } from 'react';
import './App.css';

export function App() {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      setVersion(manifest.version || 'unknown');
    } else {
      setVersion('dev');
    }
  }, []);

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1 className="popup-title">LamaniSync Dev</h1>
        <span className="popup-version" data-testid="extension-version">
          v{version}
        </span>
      </header>
      <div className="status-badge" data-testid="connection-status">
        <span className="status-indicator"></span>
        <span>Unpaired</span>
      </div>
      <p className="popup-desc">
        Chrome extension bridge for LamaniHub synchronization.
      </p>
    </div>
  );
}

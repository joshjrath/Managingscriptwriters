// The way in: a tiny text link near the wordmark that a casual visitor would miss.

import { useNavigate } from 'react-router-dom';
import { leaveForControlCenter, preloadControlCenter } from './leave';

export function ControlCenterLink() {
  const nav = useNavigate();
  const preload = () => { void preloadControlCenter().catch(() => {}); };
  return (
    <a
      href="/control-center" className="cc-link" onMouseEnter={preload} onFocus={preload}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        void leaveForControlCenter(() => { nav('/control-center'); });
      }}
    >
      Control Center
    </a>
  );
}

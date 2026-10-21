import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Design system first: tokens, then element defaults, then shared primitives.
// Feature stylesheets follow in load order and may refine, never redefine, tokens.
import './styles/system/tokens.css';
import './styles/system/base.css';
import './styles/system/components/ui.css';
import './styles/global.css';
import './styles/phase4.css';
import './styles/phase5.css';
import './styles/ui-v2-neutral.css';
import './styles/stage3.css';
import './styles/b7-construction-ui.css';
import './styles/b8-export.css';
import './styles/release-slice1.css';
import './styles/inspector-v2.css';
import './styles/inspector-v3.css';
import './styles/flip-controls.css';
import './styles/release-slice2.css';
import './styles/family-rules.css';
import './styles/phase1-redesign.css';
import './styles/keyline-reference-final.css';
import './styles/keyline-dialogs.css';
import './styles/topbar.css';
import './styles/dialogs.css';
import './styles/dashboard.css';
import './styles/phase1-match.css';
import './styles/phase1-parity.css';
import './styles/layers.css';
import './styles/motion.css';
import './styles/design-sidebar.css';
import { installCanvasTextMetrics } from './canvas/text-metrics';

// Text bounds must match the glyphs the canvas draws, so measurement is installed once,
// before the first render (docs/EDITING-AUDIT.md §3.9).
installCanvasTextMetrics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
void document.fonts?.load('600 11px Geist');

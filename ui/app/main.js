// Omnia Studio UI — entry point (ES module, no build step).
// Load order: strings → preferences → views register → shell → router → server monitors.

import './core/strings.js';
import { initPrefs } from './core/prefs.js';
import { startShell } from './core/shell.js';
import { startRouter } from './core/router.js';
import { loadSessions } from './core/sessions.js';
import { startHealthMonitor } from './api.js';
import './views/index.js';

initPrefs();
startShell();
startRouter(document.getElementById('omnia-main'));
startHealthMonitor();
loadSessions();

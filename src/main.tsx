import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/ubuntu/latin-300.css';
import '@fontsource/ubuntu/latin-400.css';
import '@fontsource/ubuntu/latin-500.css';
import '@fontsource/ubuntu/latin-700.css';
import './styles.css';
import App from './App';
import { initPwa } from './pwa';

document.documentElement.dataset.theme = 'dark';
document.documentElement.style.colorScheme = 'dark';

initPwa();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

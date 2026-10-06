import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';
if (import.meta.env.VITE_LOCAL_APP === '1') {
  document.documentElement.classList.add('local-app');
  void import('../apps/local/client.ts').then(({ bindLocalLifecycle }) => bindLocalLifecycle());
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_LOCAL_APP !== '1') navigator.serviceWorker.register('/sw.js').catch(() => {});

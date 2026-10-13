import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './src/index.css';

// Tratamento automático de chunks dinâmicos desatualizados após deploy
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    console.warn('[Vite] Versão atualizada no servidor detectada. Recarregando página...');
    window.location.reload();
  });
  window.addEventListener('error', (event) => {
    if (event?.message && /Failed to fetch dynamically imported module/i.test(event.message)) {
      console.warn('[Vite] Módulo atualizado detectado. Recarregando...');
      window.location.reload();
    }
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

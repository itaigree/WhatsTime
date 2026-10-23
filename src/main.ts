import './styles.css';
import { startApp } from './ui/app';
import { takeSharedText } from './ui/share-target';

startApp({ sharedText: takeSharedText() });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = (): void => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is optional; the app works without it.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

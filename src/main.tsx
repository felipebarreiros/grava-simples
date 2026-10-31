import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthApplication } from './auth/AuthApplication';
import { initializeAnalytics, trackPage } from './analytics/client';
import './style.css';

void initializeAnalytics();
trackPage();

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthApplication />
  </BrowserRouter>,
);

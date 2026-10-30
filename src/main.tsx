import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthApplication } from './auth/AuthApplication';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthApplication />
  </BrowserRouter>,
);

import { createRoot } from 'react-dom/client';
import { DesktopPicker } from './DesktopPicker';
import './desktop.css';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop capture root is missing');
createRoot(root).render(<DesktopPicker />);

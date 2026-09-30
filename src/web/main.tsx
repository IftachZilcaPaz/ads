import { render } from 'preact';
import { App } from './app.tsx';
import '@fontsource-variable/heebo';
import './styles.css';

render(<App />, document.getElementById('app')!);

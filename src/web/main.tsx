import { render } from 'preact';
import { App } from './app.tsx';
import '@fontsource-variable/heebo';
import '@fontsource/varela-round/400.css';
import './styles.css';

render(<App />, document.getElementById('app')!);

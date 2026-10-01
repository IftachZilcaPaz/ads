import { useEffect, useState } from 'preact/hooks';

export const ROUTES = ['board', 'calendar', 'studio', 'library', 'campaign', 'analytics', 'brand', 'settings'] as const;
export type Route = (typeof ROUTES)[number];

export interface Location {
  route: Route;
  query: URLSearchParams;
}

function parse(hash: string): Location {
  const [path = '', qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const route = (ROUTES as readonly string[]).includes(path) ? (path as Route) : 'board';
  return { route, query: new URLSearchParams(qs) };
}

/** Hash routing: works on Netlify without server rewrites and survives refresh. */
export function useLocation(): Location {
  const [loc, setLoc] = useState(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => setLoc(parse(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return loc;
}

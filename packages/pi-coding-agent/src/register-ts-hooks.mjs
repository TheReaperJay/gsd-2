import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const PACKAGES_ROOT = fileURLToPath(new URL('packages/', ROOT));

export function resolve(specifier, context, nextResolve) {
  let resolved = specifier;

  if (specifier.includes('@gsd/')) {
    // Redirect @gsd/ package imports to their TypeScript source
    resolved = specifier.replace('@gsd/', PACKAGES_ROOT).replace('/dist/', '/src/');
    if (resolved.includes('/packages/pi-ai') && !resolved.endsWith('.ts')) {
      resolved = resolved.replace(/\/packages\/pi-ai$/, '/packages/pi-ai/src/index.ts');
    } else if (!resolved.includes('/src/') && !resolved.endsWith('.ts')) {
      resolved = resolved.replace(/\/packages\/([^/]+)$/, '/packages/$1/src/index.ts');
    } else if (!resolved.endsWith('.ts') && !resolved.endsWith('.js') && !resolved.endsWith('.mjs')) {
      resolved += '/index.ts';
    }
    // Also handle sub-path imports like @gsd/pi-ai/oauth
    if (resolved.endsWith('/oauth')) {
      resolved = resolved + '/index.ts';
    }
  } else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    // Rewrite relative .js imports to .ts for TypeScript source execution
    resolved = specifier.replace(/\.js$/, '.ts');
  }

  return nextResolve(resolved, context);
}

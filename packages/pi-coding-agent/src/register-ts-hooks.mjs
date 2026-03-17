import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const PACKAGES_ROOT = fileURLToPath(new URL('packages/', ROOT));

export function resolve(specifier, context, nextResolve) {
  let resolved = specifier;

  if (specifier.includes('@gsd/')) {
    // Handle @gsd/pi-ai/oauth sub-path specifically
    if (specifier === '@gsd/pi-ai/oauth') {
      resolved = PACKAGES_ROOT + 'pi-ai/src/oauth.ts';
    } else if (specifier === '@gsd/pi-ai') {
      resolved = PACKAGES_ROOT + 'pi-ai/src/index.ts';
    } else {
      // Generic @gsd/ redirect to TypeScript source
      const pkgName = specifier.replace('@gsd/', '');
      resolved = PACKAGES_ROOT + pkgName + '/src/index.ts';
    }
  } else if (
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL &&
    (context.parentURL.includes('/packages/') || context.parentURL.includes('/src/')) &&
    !context.parentURL.includes('/node_modules/')
  ) {
    // Rewrite relative .js imports to .ts only for project TypeScript source files
    resolved = specifier.replace(/\.js$/, '.ts');
  }

  return nextResolve(resolved, context);
}

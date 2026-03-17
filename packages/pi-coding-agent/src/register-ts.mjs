import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register loader hooks that redirect .js imports to .ts files and resolve
// @gsd/ package specifiers to TypeScript source for test execution.
register(new URL('./register-ts-hooks.mjs', import.meta.url), pathToFileURL('./'));

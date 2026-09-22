/** Must be the first import in every test file: registers the .js→.ts hook. */
import { register } from 'node:module';

register(new URL('./_resolve-hook.mjs', import.meta.url));

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Usar el método recomendado por Node.js
register('ts-node/esm.mjs', pathToFileURL('./'));


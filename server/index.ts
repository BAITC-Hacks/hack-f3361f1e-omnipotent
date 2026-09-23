import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.js';
if (existsSync('.env')) loadEnvFile('.env');
const port=Number(process.env.PORT??3001);
createApp().listen(port,'127.0.0.1',()=>console.log(`Omnipotent: http://127.0.0.1:${port}`));

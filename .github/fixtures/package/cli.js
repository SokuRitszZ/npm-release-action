#!/usr/bin/env node
import fs from 'node:fs';
console.log(JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))).version);

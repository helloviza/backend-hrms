import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wb = xlsx.readFile(path.join(__dirname, 'Airline_Code.xlsx'));
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(ws);

const airlines = {};
rows.forEach(r => {
  if (r.AIRLINECODE) airlines[r.AIRLINECODE.trim()] = r.AIRLINENAME?.trim();
});

const outPath = path.join(__dirname, '../src/data/airlines.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(airlines, null, 2));
console.log(`Written ${Object.keys(airlines).length} airlines to src/data/airlines.json`);

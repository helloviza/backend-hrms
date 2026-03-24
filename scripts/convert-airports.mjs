import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wb = xlsx.readFile(path.join(__dirname, 'New_Airport_List.xlsx'));
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(ws);

const airports = rows
  .filter(r => r.AIRPORTCODE && r.CITYNAME)
  .map(r => ({
    code: r.AIRPORTCODE?.trim(),
    name: r.AIRPORTNAME?.trim(),
    city: r.CITYNAME?.trim(),
    cityCode: r.CITYCODE?.trim(),
    country: r.COUNTRYNAME?.trim(),
    countryCode: r.COUNTRYCODE?.trim(),
    label: `${r.CITYNAME} (${r.AIRPORTCODE}) - ${r.AIRPORTNAME}`,
  }));

const outPath = path.join(__dirname, '../src/data/airports.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(airports, null, 2));
console.log(`Written ${airports.length} airports to src/data/airports.json`);

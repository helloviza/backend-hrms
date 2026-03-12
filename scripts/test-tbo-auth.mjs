import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

console.log('Testing Shared URL:', process.env.TBO_SHARED_BASE_URL);

const res = await fetch(
  `${process.env.TBO_SHARED_BASE_URL}/Authenticate`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      ClientId: process.env.TBO_ClientId,
      UserName: process.env.TBO_UserName,
      Password: process.env.TBO_Password,
      EndUserIp: process.env.TBO_EndUserIp,
    })
  }
);

console.log('Status:', res.status);
const text = await res.text();
console.log('Raw response:', text.substring(0, 500));

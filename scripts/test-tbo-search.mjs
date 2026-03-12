import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// Step 1: Authenticate
const authRes = await fetch(
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
const auth = await authRes.json();
const TokenId = auth.TokenId;
console.log('Token:', TokenId);

// Tomorrow's date
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const departDate = tomorrow.toISOString().split('T')[0];
console.log('Depart date:', departDate);

const routes = [
  { Origin: "DEL", Destination: "BOM" },
  { Origin: "DEL", Destination: "CCU" },
  { Origin: "BOM", Destination: "DEL" },
  { Origin: "DEL", Destination: "BLR" },
];

for (const route of routes) {
  const searchRes = await fetch(
    `${process.env.TBO_FLIGHT_BASE_URL}/Search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        EndUserIp: process.env.TBO_EndUserIp,
        TokenId,
        AdultCount: "1",
        ChildCount: "0",
        InfantCount: "0",
        DirectFlight: "false",
        OneStopFlight: "false",
        JourneyType: "1",
        PreferredAirlines: null,
        Segments: [{
          Origin: route.Origin,
          Destination: route.Destination,
          FlightCabinClass: "2",
          PreferredDepartureTime: `${departDate}T00:00:00`,
          PreferredArrivalTime: `${departDate}T00:00:00`,
        }],
        Sources: ["TBO"],
      })
    }
  );
  const search = await searchRes.json();
  const count = search?.Response?.Results?.length || 0;
  const errMsg = search?.Response?.Error?.ErrorMessage || '';
  console.log(`${route.Origin}->${route.Destination}:`, count, 'results', errMsg);

  if (count > 0) {
    const first = search.Response.Results[0];
    const seg = first.Segments[0][0];
    console.log('  First:', seg.Airline.AirlineName, seg.Airline.FlightNumber,
      seg.Origin.DepTime, '->', seg.Destination.ArrTime,
      '₹', first.Fare.PublishedFare || first.Fare.TotalFare);
  }
}
